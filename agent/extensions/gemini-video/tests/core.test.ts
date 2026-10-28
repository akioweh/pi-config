import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GoogleGenAI } from "@google/genai";
import {
  analyse, DEFAULTS, diagnostics, fileName, loadSettings, requestFor, saveSettings,
  usageFor, validateSettings, youtubeURL, type Progress, type VideoClient,
} from "../core.ts";

const uri = "https://generativelanguage.googleapis.com/v1beta/files/video123";
const active = { name: "files/video123", uri, mimeType: "video/mp4", state: "ACTIVE" };
const completed = {
  id: "interaction-1", status: "completed", object: "interaction",
  steps: [{ type: "model_output", content: [{ type: "text", text: "At 00:42 the chart changes." }] }],
  usage: { total_input_tokens: 100, total_output_tokens: 20, total_thought_tokens: 30, total_tool_use_tokens: 200, total_cached_tokens: 40, total_tokens: 350 },
};
function mockClient({ uploadError, status, streamError, onEvent }: {
  uploadError?: Error; status?: string; streamError?: Error; onEvent?: () => void;
} = {}) {
  const calls: { operation: string; args: any }[] = [];
  return {
    calls,
    client: {
      files: {
        async upload(args: unknown) {
          calls.push({ operation: "upload", args });
          if (uploadError) throw uploadError;
          return active;
        },
        async get(args: unknown) { calls.push({ operation: "file", args }); return active; },
      },
      interactions: {
        async create(args: unknown) { calls.push({ operation: "create", args }); return { id: completed.id }; },
        async get(id: string, args?: { stream?: boolean }) {
          calls.push({ operation: "get", args: { id, ...args } });
          if (!args?.stream) return { ...completed, status: status ?? completed.status };
          return (async function* () {
            yield { event_type: "step.start", index: 0, step: { type: "thought", summary: [{ type: "text", text: "Inspecting " }], signature: "SECRET" } };
            onEvent?.();
            if (streamError) throw streamError;
            yield { event_type: "step.delta", index: 0, delta: { type: "thought_summary", content: { type: "text", text: "the chart" } } };
            yield { event_type: "step.delta", index: 0, delta: { type: "thought_signature", signature: "SECRET" } };
            yield { event_type: "step.start", index: 1, step: { type: "processing_call", id: "call-1" } };
            yield { event_type: "step.start", index: 2, step: { type: "processing_result", call_id: "call-1" } };
            yield { event_type: "step.start", index: 3, step: { type: "model_output", content: [{ type: "text", text: "At " }] } };
            yield { event_type: "step.delta", index: 3, delta: { type: "text", text: "00:42" } };
          })();
        },
        async cancel(id: string) { calls.push({ operation: "cancel", args: { id } }); },
      },
    } as unknown as VideoClient,
  };
}

test("global settings round-trip, missing defaults, and invalid settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-video-"));
  try {
    const path = join(dir, "settings.json");
    assert.deepEqual(await loadSettings(path), DEFAULTS);
    const settings = { ...DEFAULTS, mediaResolution: "high" as const };
    await saveSettings(path, settings);
    assert.deepEqual(await loadSettings(path), settings);
    assert.equal(JSON.parse(await readFile(path, "utf8")).mediaResolution, "high");
    assert.throws(() => validateSettings({ ...DEFAULTS, thinkingLevel: "minimal" }));
    assert.throws(() => validateSettings({ ...DEFAULTS, model: "toString" }));
    await writeFile(path, "not json");
    await assert.rejects(loadSettings(path));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("request preserves native continuation and repeats scoped configuration", () => {
  const settings = { ...DEFAULTS, mediaResolution: "high" as const };
  const request = requestFor({ prompt: "Inspect chart" }, settings, [{ uri, mime_type: "video/mp4" }], "parent");
  assert.equal(request.previous_interaction_id, "parent");
  assert.equal(request.input[0].type, "video");
  assert.deepEqual(request.input[0], { type: "video", uri, mime_type: "video/mp4", processing: "agentic", resolution: "high" });
  assert.deepEqual(request.generation_config, { thinking_level: "medium", thinking_summaries: "auto" });
  assert.equal(request.store, true);
  assert.equal(request.background, true);
  const followup = requestFor({ prompt: "Look again" }, DEFAULTS, [], "parent");
  assert.deepEqual(followup.input, [{ type: "text", text: "Look again" }]);
  assert.equal(followup.system_instruction, request.system_instruction);
  assert.throws(() => requestFor({ prompt: "Hi" }, DEFAULTS, []), /Provide videos/);
  assert.throws(() => requestFor({ prompt: " " }, DEFAULTS, [], "parent"), /non-empty/);
});

test("validates file and YouTube URI boundaries", () => {
  assert.equal(fileName(uri), "files/video123");
  assert.equal(youtubeURL("https://youtu.be/abc"), "https://youtu.be/abc");
  for (const bad of ["https://evil.example/v1beta/files/video123", `${uri}?token=x`, "https://generativelanguage.googleapis.com/v1beta/files/a/../../x"]) {
    assert.throws(() => fileName(bad));
  }
  for (const bad of ["http://youtu.be/abc", "https://youtube.com.evil.example/watch?v=abc", "https://user:password@youtube.com/watch?v=abc"]) {
    assert.throws(() => youtubeURL(bad));
  }
});

test("uploads local files, streams summaries and steps, and retrieves final response", async () => {
  const { client, calls } = mockClient();
  const progress: Progress[] = [];
  const result = await analyse(client, { prompt: "What changes?", videos: [{ type: "local", path: "video.mp4" }] }, DEFAULTS, "/work", undefined, (p) => progress.push(p));
  assert.equal(calls[0].args.file, "/work/video.mp4");
  assert.equal(result.answer, "At 00:42 the chart changes.");
  assert.deepEqual(result.sources, [{ uri, mime_type: "video/mp4" }]);
  assert.match(result.trace, /Inspecting the chart/);
  assert.match(result.trace, /processing_call/);
  assert.match(result.trace, /processing_result/);
  assert.match(result.trace, /At 00:42/);
  assert.doesNotMatch(result.trace, /SECRET/);
  assert.ok(progress.length > 3);
  assert.ok(!calls.some((c) => c.operation === "cancel"));
});

test("file URIs reuse Files API objects; YouTube does not upload", async () => {
  const { client, calls } = mockClient();
  await analyse(client, { prompt: "Compare", videos: [{ type: "file", uri }, { type: "youtube", url: "https://youtu.be/abc" }] }, DEFAULTS, "/work", undefined, () => {});
  assert.equal(calls.filter((c) => c.operation === "file").length, 1);
  assert.ok(!calls.some((c) => c.operation === "upload"));
  const request = calls.find((c) => c.operation === "create")!.args;
  assert.equal(request.input[1].uri, "https://youtu.be/abc");
});

test("follow-up sends only the new prompt and parent interaction ID", async () => {
  const { client, calls } = mockClient();
  await analyse(client, { prompt: "Inspect again" }, DEFAULTS, "/work", "parent-id", () => {});
  const request = calls.find((c) => c.operation === "create")!.args;
  assert.equal(request.previous_interaction_id, "parent-id");
  assert.deepEqual(request.input, [{ type: "text", text: "Inspect again" }]);
  assert.ok(!calls.some((c) => c.operation === "upload" || c.operation === "file"));
});

test("upload errors fail directly without creating an interaction", async () => {
  const failure = new Error("Upload failed");
  const { client, calls } = mockClient({ uploadError: failure });
  await assert.rejects(analyse(client, { prompt: "Analyse", videos: [{ type: "local", path: "a.mp4" }] }, DEFAULTS, "/work", undefined, () => {}), failure);
  assert.deepEqual(calls.map((c) => c.operation), ["upload"]);
});

test("abort cancels the paid background job; stream errors also cancel", async () => {
  const controller = new AbortController();
  const first = mockClient({ onEvent: () => controller.abort() });
  await assert.rejects(analyse(first.client, { prompt: "Follow up" }, DEFAULTS, "/work", "parent", () => {}, controller.signal));
  assert.equal(first.calls.filter((c) => c.operation === "cancel").length, 1);
  const second = mockClient({ streamError: new Error("Disconnected") });
  await assert.rejects(analyse(second.client, { prompt: "Follow up" }, DEFAULTS, "/work", "parent", () => {}), /Disconnected/);
  assert.equal(second.calls.filter((c) => c.operation === "cancel").length, 1);
});

test("incomplete responses fail instead of reporting success", async () => {
  const { client } = mockClient({ status: "incomplete" });
  await assert.rejects(analyse(client, { prompt: "Follow up" }, DEFAULTS, "/work", "parent", () => {}), /incomplete/);
});

test("usage includes loaded media, cache, thoughts, and output once", () => {
  const usage = usageFor(completed.usage);
  assert.equal(usage.input, 260);
  assert.equal(usage.output, 50);
  assert.equal(usage.reasoning, 30);
  assert.equal(usage.cacheRead, 40);
  assert.equal(usage.totalTokens, 350);
  assert.equal(usageFor().totalTokens, 0);
});

test("expanded diagnostics omit signatures, settings, transport internals and media blobs", () => {
  assert.deepEqual(diagnostics({
    id: "i", model: "hidden", generation_config: { thinking_level: "medium" }, sdkHttpResponse: { secret: "x" },
    steps: [{ type: "thought", signature: "SECRET", summary: [{ type: "text", text: "Checking" }] }, { type: "image", data: "BLOB", uri }],
  }), { id: "i", steps: [{ type: "thought", summary: [{ type: "text", text: "Checking" }] }, { type: "image", uri }] });
});

test("actual SDK builds Interactions requests against the configured endpoint", async () => {
  const originalFetch = globalThis.fetch;
  const requests: { url: string; body: any }[] = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push({ url: request.url, body: request.method === "POST" ? await request.json() : undefined });
    return Response.json(completed);
  };
  try {
    const client = new GoogleGenAI({ apiKey: "test-only", httpOptions: { baseUrl: "https://gemini.example", apiVersion: "v1beta" } });
    const response = await client.interactions.create(requestFor({ prompt: "Look again" }, DEFAULTS, [], "parent"), { maxRetries: 0 });
    assert.equal(response.id, completed.id);
    assert.equal(requests[0].url, "https://gemini.example/v1beta/interactions");
    assert.equal(requests[0].body.previous_interaction_id, "parent");
    assert.equal(requests[0].body.generation_config.thinking_summaries, "auto");
  } finally { globalThis.fetch = originalFetch; }
});
