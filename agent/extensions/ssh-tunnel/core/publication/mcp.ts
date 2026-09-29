import { formatSize, type ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { Resources } from "../resources.ts";
import { mapText, once, type PatchedOutput, textOf } from "./index.ts";

const binaryLabel = /\[Binary resource ([^\n]+?) \(([^\n]+?)\) (?:saved to ([^\n]+?)|could not be saved: [^\n]+?)\]/g;

function extensionOf(uri: string): string {
	const path = URL.canParse(uri) ? new URL(uri).pathname : uri;
	return /\.[A-Za-z0-9]{1,8}$/.exec(path)?.[0] ?? ".bin";
}

function isTextMimeType(mimeType?: string): boolean {
	if (!mimeType) return false;
	const type = mimeType.split(";", 1)[0].trim().toLowerCase();
	return type.startsWith("text/") || type === "application/json" || type.endsWith("+json") || type.endsWith("+xml");
}

/** Pi exposes binary MCP blobs in structuredContent; rewrite their generated labels without private Pi imports. */
export async function patchMcp(
	event: ToolResultEvent,
	resources: Resources,
	fullText: string | undefined,
	signal?: AbortSignal,
): Promise<PatchedOutput> {
	const details = event.details as { server?: string; tool?: string } | undefined;
	const payload = event.structuredContent as { content?: unknown[]; contents?: unknown[] } | undefined;
	if (typeof details?.server !== "string" || typeof details.tool !== "string" || !payload)
		return { content: event.content, fullText };
	const raw = details.tool === "read_mcp_resource" ? payload.contents : payload.content;
	const binaries = (Array.isArray(raw) ? raw : [])
		.map((item: any) => (details.tool === "read_mcp_resource" ? item : item?.type === "resource" ? item.resource : null))
		.filter(
			(resource): resource is { uri: string; mimeType?: string; blob: string } =>
				typeof resource?.uri === "string" &&
				typeof resource.blob === "string" &&
				!resource.mimeType?.startsWith("image/") &&
				!isTextMimeType(resource.mimeType),
		);
	if (binaries.length === 0) return { content: event.content, fullText };
	const labels = [...(fullText ?? textOf(event.content)).matchAll(binaryLabel)];
	if (labels.length !== binaries.length) throw new Error("Unsupported Pi MCP binary-resource label layout");
	const call = {};
	const replacements = new Map<string, string>();
	const pathReplacements = new Map<string, string>();
	for (const [index, resource] of binaries.entries()) {
		const bytes = Buffer.from(resource.blob, "base64");
		const kind = `${resource.mimeType ?? "unknown type"}, ${formatSize(bytes.length)}`;
		const label = labels[index];
		if (label[1] !== resource.uri || label[2] !== kind)
			throw new Error("Unsupported Pi MCP binary-resource label order");
		const ext = extensionOf(resource.uri);
		const target = await once(call, `${ext}:${resource.blob}`, () =>
			resources.publishData(bytes, `resource${ext}`, { signal }),
		);
		replacements.set(label[0], `[Binary resource ${resource.uri} (${kind}) saved to ${target}]`);
		if (label[3]) pathReplacements.set(label[3], target);
	}
	const rewrite = (value: string) => {
		let out = value.replace(binaryLabel, (label) => replacements.get(label) ?? label);
		for (const [source, target] of pathReplacements) out = out.replaceAll(source, target);
		return out;
	};
	return {
		content: mapText(event.content, rewrite),
		fullText: fullText === undefined ? undefined : rewrite(fullText),
	};
}
