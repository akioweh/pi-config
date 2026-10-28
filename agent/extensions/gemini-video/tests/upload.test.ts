import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { analyse, createVideoClient, DEFAULTS, videoMimeType } from "../core.ts";

const uri = "https://generativelanguage.googleapis.com/v1beta/files/video123";
const active = (mimeType: string) => ({ name: "files/video123", uri, mimeType, state: "ACTIVE" });
const sdkOptions = { apiKey: "test-only", vertexai: false, httpOptions: { baseUrl: "https://gemini.example", apiVersion: "v1beta" } };

async function temporaryDirectory(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "gemini-video-upload-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function uploadStarted() {
  return new Response("", { headers: { "x-goog-upload-url": "https://gemini.example/upload/session" } });
}

test("real SDK uploads every allowed video extension using its explicit MIME type", async (t) => {
  const dir = await temporaryDirectory(t);
  const cases = {
    "mp4": "video/mp4", "mpeg": "video/mpeg", "mpg": "video/mpg", "MOV": "video/mov",
    "avi": "video/avi", "flv": "video/x-flv", "webm": "video/webm", "wmv": "video/wmv",
    "3gp": "video/3gpp", "3gpp": "video/3gpp",
  };
  for (const [extension, mimeType] of Object.entries(cases)) {
    const path = `recording.${extension}`;
    await writeFile(join(dir, path), "video test bytes");
    let uploads = 0;
    const client = createVideoClient({ ...sdkOptions, httpOptions: { ...sdkOptions.httpOptions,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const command = request.headers.get("x-goog-upload-command");
        if (command === "start") {
          assert.equal(request.headers.get("x-goog-upload-header-content-type"), mimeType);
          assert.equal((await request.json()).file.mimeType, mimeType);
          return uploadStarted();
        }
        if (command?.startsWith("upload")) {
          uploads++;
          assert.equal(await request.text(), "video test bytes");
          return Response.json({ file: active(mimeType) }, { headers: { "x-goog-upload-status": "final" } });
        }
        if (request.method === "POST") {
          const body = await request.json();
          assert.equal(body.input[0].mime_type, mimeType);
          return Response.json({ id: "i-1", status: "in_progress", object: "interaction" });
        }
        const url = new URL(request.url);
        if (url.searchParams.get("stream") === "true" || url.searchParams.get("alt") === "sse") {
          return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
        }
        return Response.json({ id: "i-1", status: "completed", object: "interaction",
          steps: [{ type: "model_output", content: [{ type: "text", text: "Done" }] }],
        });
      },
    } });
    const result = await analyse(client, { prompt: "Analyse", videos: [{ type: "local", path }] }, DEFAULTS, dir, undefined, () => {});
    assert.equal(result.answer, "Done");
    assert.equal(uploads, 1, extension);
  }
});

test("unsupported local files reject the whole batch before any SDK upload", async (t) => {
  const dir = await temporaryDirectory(t);
  await writeFile(join(dir, "private.txt"), "PRIVATE TEST CONTENT");
  let requests = 0;
  const client = createVideoClient({ ...sdkOptions, httpOptions: { ...sdkOptions.httpOptions,
    fetch: async () => { requests++; throw new Error("Unexpected HTTP request"); },
  } });
  await assert.rejects(analyse(client, {
    prompt: "Analyse", videos: [{ type: "local", path: "first.mp4" }, { type: "local", path: "private.txt" }],
  }, DEFAULTS, dir, undefined, () => {}), /Unsupported video file extension: .txt/);
  assert.equal(requests, 0);
  for (const path of ["private.txt", "sound.mp3", "archive.zip", "no-extension"]) {
    assert.throws(() => videoMimeType(path), /Unsupported video file extension/);
  }
});

test("cancelling real SDK upload initialization aborts its HTTP request", { timeout: 3000 }, async (t) => {
  const dir = await temporaryDirectory(t);
  await writeFile(join(dir, "recording.mp4"), "video test bytes");
  const controller = new AbortController();
  const started = deferred();
  let requests = 0;
  let requestSignal: AbortSignal | undefined;
  const client = createVideoClient({ ...sdkOptions, httpOptions: { ...sdkOptions.httpOptions,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests++;
      assert.equal(request.headers.get("x-goog-upload-command"), "start");
      requestSignal = request.signal;
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
        started.resolve();
      });
    },
  } }, controller.signal);
  const rejected = assert.rejects(analyse(client, {
    prompt: "Analyse", videos: [{ type: "local", path: "recording.mp4" }],
  }, DEFAULTS, dir, undefined, () => {}, controller.signal), /abort/i);
  await started.promise;
  controller.abort();
  await rejected;
  assert.equal(requestSignal?.aborted, true);
  assert.equal(requests, 1);
});

test("cancelling an in-flight SDK chunk aborts it and prevents the next chunk", { timeout: 3000 }, async (t) => {
  const dir = await temporaryDirectory(t);
  await writeFile(join(dir, "large.mp4"), Buffer.alloc(9 * 1024 * 1024));
  const controller = new AbortController();
  const started = deferred();
  let chunks = 0;
  let requestSignal: AbortSignal | undefined;
  const client = createVideoClient({ ...sdkOptions, httpOptions: { ...sdkOptions.httpOptions,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      if (request.headers.get("x-goog-upload-command") === "start") return uploadStarted();
      chunks++;
      assert.equal(request.headers.get("x-goog-upload-offset"), "0");
      assert.equal((await request.arrayBuffer()).byteLength, 8 * 1024 * 1024);
      requestSignal = request.signal;
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
        started.resolve();
      });
    },
  } }, controller.signal);
  const rejected = assert.rejects(analyse(client, {
    prompt: "Analyse", videos: [{ type: "local", path: "large.mp4" }],
  }, DEFAULTS, dir, undefined, () => {}, controller.signal), /abort/i);
  await started.promise;
  controller.abort();
  await rejected;
  assert.equal(requestSignal?.aborted, true);
  assert.equal(chunks, 1);
});

test("cancellation between SDK upload chunks prevents further transfer", { timeout: 3000 }, async (t) => {
  const dir = await temporaryDirectory(t);
  await writeFile(join(dir, "large.mp4"), Buffer.alloc(9 * 1024 * 1024));
  const controller = new AbortController();
  let chunks = 0;
  const client = createVideoClient({ ...sdkOptions, httpOptions: { ...sdkOptions.httpOptions,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      if (request.headers.get("x-goog-upload-command") === "start") return uploadStarted();
      chunks++;
      controller.abort();
      return Response.json({}, { headers: { "x-goog-upload-status": "active" } });
    },
  } }, controller.signal);
  await assert.rejects(analyse(client, {
    prompt: "Analyse", videos: [{ type: "local", path: "large.mp4" }],
  }, DEFAULTS, dir, undefined, () => {}, controller.signal), /abort/i);
  assert.equal(chunks, 1);
});

test("upload cancellation does not block the independent background-cancel request", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const client = createVideoClient({ ...sdkOptions, httpOptions: { ...sdkOptions.httpOptions,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      assert.equal(request.signal.aborted, false);
      assert.match(request.url, /\/interactions\/i-1\/cancel$/);
      cancelled = true;
      return Response.json({ id: "i-1", status: "cancelled", object: "interaction" });
    },
  } }, controller.signal);
  controller.abort();
  await client.interactions.cancel("i-1", undefined, { signal: AbortSignal.timeout(1000), maxRetries: 0 });
  assert.equal(cancelled, true);
});
