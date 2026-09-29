import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { ExtensionAPI, ToolResultEvent, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import type { Resources } from "../resources.ts";
import { patchCodemode } from "./codemode.ts";
import type { RewriteDocs } from "./docs.ts";
import { type Guard, mapText, once } from "./index.ts";
import { patchMcp } from "./mcp.ts";

async function patchToolResult(
	event: ToolResultEvent,
	path: string | undefined,
	resources: Resources,
	rewriteDocs: RewriteDocs,
	signal?: AbortSignal,
): Promise<ToolResultEventResult> {
	const details = event.details as { fullOutputPath?: string; server?: string; tool?: string } | undefined;
	const isMcp = Boolean(details?.server && details?.tool && event.structuredContent);
	const fullText = (event.toolName === "codemode" || isMcp) && path ? await readFile(path, "utf8") : undefined;
	const docsText =
		fullText !== undefined && event.toolName === "codemode"
			? await rewriteDocs(fullText, resources, signal)
			: fullText;
	const patched = isMcp
		? await patchMcp(event, resources, docsText, signal)
		: await patchCodemode(event, resources, docsText, signal);
	const content =
		event.toolName === "codemode"
			? await Promise.all(
					patched.content.map(async (block) =>
						block.type === "text" ? { ...block, text: await rewriteDocs(block.text, resources, signal) } : block,
					),
				)
			: patched.content;
	if (!path) return { content, structuredContent: event.structuredContent };
	const target =
		patched.fullText !== undefined && patched.fullText !== fullText
			? await resources.publishData(patched.fullText, basename(path), { signal })
			: await resources.publishFile(path, { signal });
	const structuredContent = event.structuredContent;
	return {
		content: mapText(content, (text) => text.replaceAll(path, target)),
		details: { ...details, fullOutputPath: target },
		structuredContent:
			structuredContent &&
			typeof structuredContent === "object" &&
			!Array.isArray(structuredContent) &&
			"full_output_path" in structuredContent &&
			structuredContent.full_output_path === path
				? { ...structuredContent, full_output_path: target }
				: structuredContent,
	};
}

export function registerSpills(
	pi: ExtensionAPI,
	guard: Guard,
	rewriteDocs: RewriteDocs = async (text) => text,
): void {
	// Throws discard result details; progress still supplies an authoritative spill path.
	const progressFiles = new Map<string, string>();
	pi.on("tool_execution_update", (event) => {
		const path = event.partialResult?.details?.fullOutputPath;
		if (typeof path === "string") progressFiles.set(event.toolCallId, path);
	});
	pi.on("tool_execution_end", (event) => {
		progressFiles.delete(event.toolCallId);
	});
	pi.on("tool_result", (event, ctx) => {
		const details = event.details as { fullOutputPath?: string; server?: string; tool?: string } | undefined;
		const path = details?.fullOutputPath ?? progressFiles.get(event.toolCallId);
		const isMcp = Boolean(details?.server && details?.tool && event.structuredContent);
		if (!path && event.toolName !== "codemode" && !isMcp) return;
		return guard(
			ctx,
			(resources) => patchToolResult(event, path, resources, rewriteDocs, ctx.signal),
			// details must be {} (not undefined) so Pi's hook merger overwrites the local fullOutputPath.
			{ content: [], structuredContent: null, details: {}, isError: true },
		);
	});
	// shortcut: user-bash entries are append-only in SessionManager, so local spill paths are projected until local temp cleanup.
	pi.on("context", (event, ctx) => {
		if (!event.messages.some((m) => m.role === "bashExecution" && !m.excludeFromContext && m.fullOutputPath)) return;
		return guard(
			ctx,
			async (resources) => {
				const messages = [];
				for (const message of event.messages) {
					if (message.role !== "bashExecution" || message.excludeFromContext || !message.fullOutputPath) {
						messages.push(message);
						continue;
					}
					const source = message.fullOutputPath;
					const target = await once(resources, `bash:${source}`, () =>
						resources.publishFile(source, { signal: ctx.signal }),
					);
					messages.push({ ...message, fullOutputPath: target });
				}
				return { messages };
			},
			{ messages: [] },
		);
	});
}
