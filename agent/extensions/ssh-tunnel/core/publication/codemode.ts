import { formatSize, type ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { Resources } from "../resources.ts";
import { once, type PatchedOutput, textOf } from "./index.ts";

const imageLabel = /\[Image saved to ([^\n]+?) \((image\/(?:png|jpeg|gif|webp)), ([^)\n]+)\)\]/g;
const extensions: Record<string, string> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/gif": ".gif",
	"image/webp": ".webp",
};

/** Pi exposes image bytes, but their saved paths only exist in generated labels. Never open those labels' paths. */
export async function patchCodemode(
	event: ToolResultEvent,
	resources: Resources,
	fullText: string | undefined,
	signal?: AbortSignal,
): Promise<PatchedOutput> {
	const images = event.content.filter((block) => block.type === "image");
	if (event.toolName !== "codemode" || images.length === 0) return { content: event.content, fullText };
	// Pi writes the spill file before adding image labels to content; match complete labels in both.
	const contentLabels = [...textOf(event.content).matchAll(imageLabel)];
	const fullLabels = fullText === undefined ? [] : [...fullText.matchAll(imageLabel)];
	if (
		(contentLabels.length !== 0 && contentLabels.length !== images.length) ||
		(fullLabels.length !== 0 && fullLabels.length !== images.length)
	)
		throw new Error("Unsupported Pi codemode image-label layout");
	const call = {};
	const replacements = new Map<string, string>();
	const remoteLabels: string[] = [];
	for (const [index, image] of images.entries()) {
		const extension = extensions[image.mimeType];
		if (!extension) throw new Error(`Unsupported Pi codemode image type: ${image.mimeType}`);
		const bytes = Buffer.from(image.data, "base64");
		for (const label of [contentLabels[index], fullLabels[index]]) {
			if (label && (label[2] !== image.mimeType || label[3] !== formatSize(bytes.length)))
				throw new Error("Unsupported Pi codemode image-label order");
		}
		const target = await once(call, image.data, () => resources.publishData(bytes, `image${extension}`, { signal }));
		const remoteLabel = `[Image saved to ${target} (${image.mimeType}, ${formatSize(bytes.length)})]`;
		for (const label of [contentLabels[index], fullLabels[index]]) {
			if (label) replacements.set(label[0], remoteLabel);
		}
		remoteLabels.push(remoteLabel);
	}
	const rewrite = (value: string) => value.replace(imageLabel, (label) => replacements.get(label) ?? label);
	let index = 0;
	const content: ToolResultEvent["content"] = [];
	for (const block of event.content) {
		if (block.type === "text") content.push({ ...block, text: rewrite(block.text) });
		else {
			const label = remoteLabels[index++];
			const previous = content.at(-1);
			if (previous?.type !== "text" || !previous.text.endsWith(label)) content.push({ type: "text", text: label });
			content.push(block);
		}
	}
	return {
		content,
		fullText:
			fullText === undefined
				? undefined
				: rewrite(fullText) + (fullLabels.length === 0 ? `\n${remoteLabels.join("\n")}` : ""),
	};
}
