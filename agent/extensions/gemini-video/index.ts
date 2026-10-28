import { join } from "node:path";
import { calculateCost, Type, type Usage } from "@earendil-works/pi-ai";
import {
  getAgentDir, getMarkdownTheme, type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Loader, Markdown, Text, type TUI } from "@earendil-works/pi-tui";
import { analyse, createVideoClient, diagnostics, loadSettings, type Progress, type Source, usageFor } from "./core.ts";
import { showMenu } from "./menu.ts";

const Params = Type.Object({
  prompt: Type.String({ minLength: 1, description: "Question or follow-up instructions for the video analyst." }),
  videos: Type.Optional(Type.Array(Type.Union([
    Type.Object({ type: Type.Literal("local"), path: Type.String({ minLength: 1 }) }),
    Type.Object({ type: Type.Literal("youtube"), url: Type.String({ minLength: 1 }) }),
    Type.Object({ type: Type.Literal("file"), uri: Type.String({ minLength: 1 }) }),
  ]), { minItems: 1 })),
  previous_analysis_id: Type.Optional(Type.String({ description: "Analysis ID from an earlier result on this conversation branch." })),
}, { additionalProperties: false });
const Output = Type.Object({
  answer: Type.String(),
  analysis_id: Type.String(),
  files: Type.Array(Type.String()),
});
interface Details extends Progress {
  analysisId?: string;
  interactionId?: string;
  response?: unknown;
  usage?: Usage;
}
interface RenderState {
  loader?: Loader;
  stop?: () => void;
}

export default function (pi: ExtensionAPI) {
  const settingsPath = join(getAgentDir(), "gemini-video.json");
  const loaders = new Set<() => void>();
  const stopLoaders = () => { for (const stop of loaders) stop(); loaders.clear(); };
  pi.on("session_shutdown", stopLoaders);
  pi.on("session_tree", stopLoaders);
  pi.registerCommand("gemini-video", {
    description: "Configure the video analyst's model, thinking level and resolution globally",
    handler: async (_args, ctx) => {
      try { await showMenu(ctx, settingsPath); }
      catch (error) { ctx.ui.notify(String(error), "error"); }
    },
  });
  pi.registerTool<typeof Params, Details, RenderState>({
    name: "gemini_video_analysis",
    label: "Gemini video analysis",
    description: "Ask a Gemini video analyst to inspect local videos, public YouTube videos or uploaded Gemini files using agentic video understanding. Continue the analyst conversation with previous_analysis_id and a new prompt. Reuse returned Gemini file URIs for subsequent analyses of the same video instead of submitting the local path again. Local paths are relative to the working directory; model settings are controlled by the user through /gemini-video.",
    parameters: Params,
    outputSchema: Output,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (!params.prompt.trim()) throw new Error("A non-empty analysis prompt is required.");
      let previous: Details | undefined;
      if (params.previous_analysis_id) {
        for (const entry of ctx.sessionManager.getBranch()) {
          if (entry.type !== "custom" || entry.customType !== "gemini-video-analysis") continue;
          const details = entry.data as Details | undefined;
          if (details?.analysisId === params.previous_analysis_id) previous = details;
        }
        if (!previous?.interactionId) throw new Error("Analysis ID not found on the active conversation branch.");
      } else if (!params.videos?.length) throw new Error("Provide videos for a new analysis.");
      const settings = await loadSettings(settingsPath);
      const model = ctx.modelRegistry.find("google", settings.model);
      if (!model) throw new Error("Configured Gemini model is unavailable. Select one with /gemini-video.");
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) throw new Error(auth.error);
      if (!auth.apiKey) throw new Error("Configure Google Gemini authentication with /login.");
      const headers = Object.fromEntries(Object.entries({ ...model.headers, ...auth.headers })
        .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
      const endpoint = auth.baseUrl ?? model.baseUrl;
      const client = createVideoClient({
        apiKey: auth.apiKey, vertexai: false,
        httpOptions: {
          baseUrl: endpoint.replace(/\/v1beta\/?$/, ""), apiVersion: "v1beta", headers,
        },
      }, signal);
      const analysis = await analyse(client, params, settings, ctx.cwd, previous?.interactionId,
        (progress) => onUpdate?.({ content: [{ type: "text", text: progress.phase }], details: progress }), signal);
      const usage = usageFor(analysis.interaction.usage);
      calculateCost(model, usage);
      const sources: Source[] = [...(previous?.sources ?? []), ...analysis.sources];
      const result = {
        answer: analysis.answer,
        analysis_id: toolCallId,
        files: [...new Set(sources.map((source) => source.uri).filter((uri) => uri.startsWith("https://generativelanguage.googleapis.com/")))],
      };
      const details: Details = {
        phase: "Completed", trace: analysis.trace, sources,
        analysisId: toolCallId, interactionId: analysis.interaction.id,
        response: diagnostics(analysis.interaction), usage,
      };
      // Nested tool calls do not get their own transcript messages; custom entries follow the branch in both cases.
      pi.appendEntry("gemini-video-analysis", { analysisId: toolCallId, interactionId: analysis.interaction.id, sources });
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, details, usage };
    },
    renderCall(args, theme, context) {
      if (context.executionStarted && context.isPartial) {
        if (!context.state.loader) {
          let queued = false;
          let invalidating = false;
          let active = true;
          // Loader only needs requestRender; the tool renderer exposes invalidate instead of a TUI.
          const ui = { requestRender() {
            if (!active || queued || invalidating) return;
            queued = true;
            queueMicrotask(() => {
              queued = false;
              if (!active) return;
              invalidating = true;
              try { context.invalidate(); } finally { invalidating = false; }
            });
          } } as TUI;
          const loader = new Loader(ui, (text) => theme.fg("accent", text), (text) => theme.fg("muted", text), "Analyzing video");
          const stop = () => { active = false; loader.stop(); loaders.delete(stop); };
          context.state.loader = loader;
          context.state.stop = stop;
          loaders.add(stop);
        }
        return context.state.loader;
      }
      context.state.stop?.();
      return new Text(theme.fg("toolTitle", theme.bold("Gemini video analysis"))
        + (context.expanded ? `\n${JSON.stringify(args, null, 2)}` : ""), 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      if (!isPartial) context.state.stop?.();
      const details = result.details as Details | undefined;
      if (!expanded) {
        if (isPartial) return new Text("", 0, 0);
        const cost = details?.usage ? ` · $${details.usage.cost.total.toFixed(4)}` : "";
        return new Text(theme.fg(context.isError ? "error" : "muted", context.isError
          ? result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")
          : `Analysis complete${cost}`), 0, 0);
      }
      const output = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      const text = isPartial
        ? `${details?.phase ?? "Analyzing video"}\n\n${details?.trace ?? ""}`
        : context.isError ? output
        : `${(JSON.parse(output) as { answer: string }).answer}\n\nDiagnostics\n\n\`\`\`json\n${JSON.stringify(details, null, 2)}\n\`\`\``;
      const component = context.lastComponent instanceof Markdown ? context.lastComponent
        : new Markdown("", 0, 0, getMarkdownTheme());
      component.setText(text);
      return component;
    },
  });
}
