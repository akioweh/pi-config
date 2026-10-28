import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadSettings } from "../core.ts";

const root = process.env.PI_PACKAGE_DIR ?? "/usr/lib/node_modules/pi";
const loaderPath = join(root, "packages/coding-agent/dist/core/extensions/loader.js");
const fromPi = (path: string): Promise<any> => import(pathToFileURL(join(root, path)).href);

test("Pi loads the tool; native renderers, menu, branch continuation and footer accounting work", {
  skip: !existsSync(loaderPath), timeout: 10000,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-video-pi-"));
  const priorDir = process.env.PI_CODING_AGENT_DIR;
  const priorFetch = globalThis.fetch;
  process.env.PI_CODING_AGENT_DIR = dir;
  let extension: any;
  try {
    const { loadExtensions } = await fromPi("packages/coding-agent/dist/core/extensions/loader.js");
    const themes = await fromPi("packages/coding-agent/dist/modes/interactive/theme/theme.js");
    const { googleProvider } = await fromPi("node_modules/@earendil-works/pi-ai/dist/providers/google.js");
    const { FooterComponent } = await fromPi("packages/coding-agent/dist/modes/interactive/components/footer.js");
    themes.initTheme("dark");
    const theme = themes.theme;
    const path = join(dirname(fileURLToPath(import.meta.url)), "../index.ts");
    const loaded = await loadExtensions([path], dir);
    assert.deepEqual(loaded.errors, []);
    extension = loaded.extensions[0];
    const tool = extension.tools.get("gemini_video_analysis").definition;
    assert.deepEqual(Object.keys(tool.parameters.properties), ["prompt", "videos", "previous_analysis_id"]);
    assert.equal(tool.parameters.additionalProperties, false);
    const entries: any[] = [];
    loaded.runtime.appendEntry = (customType: string, data: unknown) => entries.push({ type: "custom", customType, data });
    const models = googleProvider().getModels();
    const model = models.find((m: any) => m.id === "gemini-3.8-flash");
    assert.ok(model);
    const context: any = {
      cwd: dir, mode: "tui", sessionManager: { getBranch: () => entries },
      modelRegistry: {
        find: (_provider: string, id: string) => models.find((m: any) => m.id === id),
        getAvailable: () => models,
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
      },
    };
    const requests: any[] = [];
    let gets = 0;
    let generation = 0;
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.method === "POST") {
        generation++;
        requests.push(await request.json());
        return Response.json({ id: `i-${generation}`, status: "in_progress", object: "interaction" });
      }
      gets++;
      if (gets % 2) {
        return new Response([
          { event_type: "step.start", index: 0, step: { type: "thought", summary: [{ type: "text", text: "Checking" }], signature: "SECRET" } },
          { event_type: "step.start", index: 1, step: { type: "processing_call", id: "p-1" } },
          { event_type: "step.start", index: 2, step: { type: "processing_result", call_id: "p-1" } },
          { event_type: "interaction.completed", interaction: { id: `i-${generation}`, status: "completed", object: "interaction" } },
        ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return Response.json({
        id: `i-${generation}`, status: "completed", object: "interaction", model: model.id,
        steps: [{ type: "thought", signature: "SECRET", summary: [{ type: "text", text: "Checking" }] },
          { type: "model_output", content: [{ type: "text", text: "The chart changes at 00:42." }] }],
        usage: { total_input_tokens: 100, total_tool_use_tokens: 200, total_thought_tokens: 30, total_output_tokens: 20, total_cached_tokens: 40, total_tokens: 350 },
      });
    };
    const updates: any[] = [];
    const first = await tool.execute("call-1", { prompt: "Find the chart", videos: [{ type: "youtube", url: "https://youtu.be/abc" }] }, undefined, (update: any) => updates.push(update), context);
    assert.ok(first.usage.cost.total > 0);
    assert.equal(first.usage.input, 260);
    assert.ok(updates.some((update) => update.details.trace.includes("Checking")));
    assert.ok(!JSON.stringify(first.content).includes(model.id));
    assert.ok(!JSON.stringify(first.details).includes("SECRET"));
    assert.deepEqual(Object.keys(first.structuredContent), ["answer", "analysis_id", "files"]);
    await tool.execute("nested/2", { prompt: "Inspect again", previous_analysis_id: "call-1" }, undefined, undefined, context);
    assert.equal(requests[1].previous_interaction_id, "i-1");
    assert.deepEqual(requests[1].input, [{ type: "text", text: "Inspect again" }]);
    const branch = entries.splice(0);
    await assert.rejects(tool.execute("call-3", { prompt: "Inspect again", previous_analysis_id: "call-1" }, undefined, undefined, context), /active conversation branch/);
    entries.push(...branch);

    const footerEntries = [{ type: "message", message: { role: "toolResult", usage: first.usage } }];
    const footer = new FooterComponent({
      model, getContextUsage: () => null,
      sessionManager: { getEntries: () => footerEntries, getEntryCount: () => 1, getSessionId: () => "s", getLeafId: () => "l" },
    }, {});
    assert.equal(footer.getSessionStats().usageTotals.cost, first.usage.cost.total);

    const state: any = {};
    let redraws = 0;
    let pending: any;
    const renderContext: any = {
      state, executionStarted: true, isPartial: true, expanded: false, isError: false,
      invalidate() {
        redraws++;
        assert.ok(redraws < 30, "loader invalidation must not loop");
        pending?.invalidate();
        pending = tool.renderCall({}, theme, renderContext);
      },
    };
    pending = tool.renderCall({}, theme, renderContext);
    assert.match(pending.render(100).join("\n"), /Analyzing video/);
    await delay(180);
    assert.ok(redraws > 1);
    tool.renderResult(first, { expanded: false, isPartial: false }, theme, renderContext);
    const stoppedAt = redraws;
    await delay(100);
    assert.equal(redraws, stoppedAt, "completed tool must stop its loader");
    renderContext.isPartial = false;
    const verbose = tool.renderResult(first, { expanded: true, isPartial: false }, theme, renderContext);
    const rendered = verbose.render(100).join("\n");
    assert.match(rendered, /The chart changes/);
    assert.match(rendered, /total_tool_use_tokens/);
    assert.doesNotMatch(rendered, /SECRET/);
    const narrow = verbose.render(28);
    assert.ok(narrow.length > 0);

    context.ui = {
      notify: (message: string, kind: string) => assert.notEqual(kind, "error", message),
      custom: async (factory: any) => {
        const component = factory({ requestRender() {} }, theme, {
          matches: (data: string, action: string) => action === "tui.select.cancel" && data === "\x1b",
        }, () => {});
        assert.match(component.render(120).join("\n"), /Model:.*Thinking:.*Resolution:/);
        component.handleInput("\t");
        component.handleInput("\x1b[B");
        component.handleInput("\r");
        await delay(50);
        assert.equal((await loadSettings(join(dir, "gemini-video.json"))).thinkingLevel, "high");
        component.handleInput("\t");
        component.handleInput("\x1b[B");
        component.handleInput("\r");
        await delay(50);
        assert.equal((await loadSettings(join(dir, "gemini-video.json"))).mediaResolution, "low");
        component.handleInput("\x1b[Z");
        assert.match(component.render(120).join("\n"), /Thinking: high/);
        component.handleInput("\x1b[Z");
        component.handleInput("\x1b[A");
        component.handleInput("\r");
        await delay(50);
        assert.equal((await loadSettings(join(dir, "gemini-video.json"))).model, "gemini-3.6-flash");
      },
    };
    await extension.commands.get("gemini-video").handler("", context);
    assert.deepEqual(await loadSettings(join(dir, "gemini-video.json")), {
      model: "gemini-3.6-flash", thinkingLevel: "high", mediaResolution: "low",
    });
    const configured = await tool.execute("call-4", { prompt: "New analysis", videos: [{ type: "youtube", url: "https://youtu.be/abc" }] }, undefined, undefined, context);
    assert.equal(requests[2].model, "gemini-3.6-flash");
    assert.equal(requests[2].generation_config.thinking_level, "high");
    assert.equal(requests[2].input[0].resolution, "low");
    assert.ok(!JSON.stringify(configured.content).includes("thinking_level"));
  } finally {
    for (const handler of extension?.handlers.get("session_shutdown") ?? []) await handler({}, {});
    globalThis.fetch = priorFetch;
    if (priorDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorDir;
    await rm(dir, { recursive: true, force: true });
  }
});
