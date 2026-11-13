import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "/usr/lib/node_modules/pi/node_modules/jiti/lib/jiti.mjs";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-ai/compat": "/usr/lib/node_modules/pi/packages/ai/dist/compat.js",
  },
});
const extension = await jiti.import("./index.ts", { default: true });
const config = JSON.parse(readFileSync(new URL("../../models.json", import.meta.url), "utf8"));
const model = {
  ...config.providers.google.models[0],
  provider: "google",
  api: "google-generative-ai",
  baseUrl: "https://generativelanguage.googleapis.com/v1beta",
};
let provider;
extension({ registerProvider(id, value) {
  assert.equal(id, "google");
  provider = value;
} });
assert.equal(provider.models, undefined, "Preserve Google's existing model catalog");

for (const level of ["low", "medium", "high", "xhigh"]) {
  test(`Hydrogen serializes ${level} and preserves the payload hook`, async () => {
    let called = false;
    const stream = provider.streamSimple(model, {
      messages: [{ role: "user", content: "Hello", timestamp: 0 }],
    }, {
      apiKey: "not-a-real-key",
      reasoning: level,
      maxRetries: 0,
      onPayload(payload, requestModel) {
        called = true;
        assert.equal(requestModel.id, model.id);
        assert.equal(payload.config.thinkingConfig.thinkingLevel, level.toUpperCase());
        assert.equal(payload.config.thinkingConfig.thinkingBudget, undefined);
        throw new Error("TEST_STOP_BEFORE_NETWORK");
      },
    });
    const result = await stream.result();
    assert(called);
    assert.match(result.errorMessage, /TEST_STOP_BEFORE_NETWORK/);
  });
}

test("Other Google models retain their normal thinking behavior", async () => {
  const other = { ...model, id: "gemini-3.8-flash", thinkingLevelMap: { ...model.thinkingLevelMap, xhigh: null } };
  let called = false;
  const result = await provider.streamSimple(other, {
    messages: [{ role: "user", content: "Hello", timestamp: 0 }],
  }, {
    apiKey: "not-a-real-key",
    reasoning: "xhigh",
    maxRetries: 0,
    onPayload(payload) {
      called = true;
      assert.equal(payload.config.thinkingConfig.thinkingLevel, "HIGH");
      throw new Error("TEST_STOP_BEFORE_NETWORK");
    },
  }).result();
  assert(called);
  assert.match(result.errorMessage, /TEST_STOP_BEFORE_NETWORK/);
});
