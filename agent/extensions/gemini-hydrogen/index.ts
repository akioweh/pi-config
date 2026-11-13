import { googleGenerativeAIApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const google = googleGenerativeAIApi();
  pi.registerProvider("google", {
    api: "google-generative-ai",
    streamSimple(model, context, options) {
      if (model.id !== "gemini-4-hydrogen" || options?.reasoning !== "xhigh") {
        return google.streamSimple(model, context, options);
      }

      return google.streamSimple(model, context, {
        ...options,
        reasoning: "high",
        async onPayload(payload, requestModel) {
          // Pi's Google adapter rejects xhigh before serialization; set it after conversion.
          const params = payload as { config: { thinkingConfig: { thinkingLevel: string } } };
          params.config.thinkingConfig.thinkingLevel = "XHIGH";
          return (await options.onPayload?.(payload, requestModel)) ?? payload;
        },
      });
    },
  });
}
