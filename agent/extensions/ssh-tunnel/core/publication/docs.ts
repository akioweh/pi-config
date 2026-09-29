import { basename, posix } from "node:path";
import { type ExtensionAPI, getDocsPath, getExamplesPath, getReadmePath } from "@earendil-works/pi-coding-agent";
import type { Resources } from "../resources.ts";
import { type Guard, once } from "./index.ts";

export type RewriteDocs = (text: string, resources: Resources, signal?: AbortSignal) => Promise<string>;

const docPaths = () => [getReadmePath(), getDocsPath(), getExamplesPath()];

/** Stock prompt/tool metadata advertises these known resources; never infer files from arbitrary paths. */
export const rewriteDocs: RewriteDocs = async (text, resources, signal) => {
	const sources = docPaths();
	if (!sources.some((path) => text.includes(path))) return text;
	const pairs = await once(resources, "docs", async () => {
		const directory = await resources.publishBundle(sources, { signal });
		return sources.map((path): [string, string] => [path, posix.join(directory, basename(path))]);
	});
	for (const [source, target] of pairs) text = text.replaceAll(source, target);
	return text;
};

export function registerDocs(pi: ExtensionAPI, guard: Guard): RewriteDocs {
	pi.on("before_agent_start", (event, ctx) => {
		const docs =
			event.systemPromptOptions.sections.docs ?? /<docs>\n([\s\S]*?)\n<\/docs>/.exec(event.systemPrompt)?.[1];
		if (!docs) return;
		// Blank out before awaiting so a failed turn cannot persist local paths; Pi ignores "" as unset.
		event.systemPromptOptions.sections.docs = " ";
		return guard(ctx, async (resources) => {
			event.systemPromptOptions.sections.docs = await rewriteDocs(docs, resources, ctx.signal);
		});
	});
	// Tool descriptions (such as codemode's docs pointer) live on system messages, outside before_agent_start.
	pi.on("context_with_system", (event, ctx) =>
		guard(
			ctx,
			async (resources) => ({
				messages: await Promise.all(
					event.messages.map(async (message) =>
						message.role === "system" && message.toolsAdded
							? {
									...message,
									toolsAdded: await Promise.all(
										message.toolsAdded.map(async (tool) => ({
											...tool,
											description: await rewriteDocs(tool.description, resources, ctx.signal),
										})),
									),
								}
							: message,
					),
				),
			}),
			{ messages: [] },
		),
	);
	return rewriteDocs;
}
