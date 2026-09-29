import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { Resources } from "../resources.ts";
import { registerClipboard } from "./clipboard.ts";
import { registerDocs } from "./docs.ts";
import { registerSkills } from "./skills.ts";
import { registerSpills } from "./spills.ts";

export type Guard = <T>(
	ctx: ExtensionContext,
	work: (resources: Resources) => Promise<T>,
	fallback?: T,
) => Promise<T | undefined>;

export interface PatchedOutput {
	content: ToolResultEvent["content"];
	fullText?: string;
}

const caches = new WeakMap<object, Map<string, Promise<unknown>>>();

/** Memoize async publication work for the lifetime of `scope` (`resources` for a session, `event` for one call). */
export function once<T>(scope: object, key: string, work: () => Promise<T>): Promise<T> {
	let map = caches.get(scope);
	if (!map) caches.set(scope, (map = new Map()));
	let pending = map.get(key) as Promise<T> | undefined;
	if (!pending) {
		pending = work().catch((error) => {
			map!.delete(key);
			throw error;
		});
		map.set(key, pending);
	}
	return pending;
}

export function textOf(content: ToolResultEvent["content"]): string {
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

export function mapText(
	content: ToolResultEvent["content"],
	rewrite: (text: string) => string,
): ToolResultEvent["content"] {
	return content.map((block) => (block.type === "text" ? { ...block, text: rewrite(block.text) } : block));
}

export function registerPublication(
	pi: ExtensionAPI,
	getResources: () => Resources,
	stop: (error: unknown, ctx: ExtensionContext) => void,
): void {
	// Pi catches hook errors. Explicit cancellation and redaction must happen before returning.
	const guard: Guard = async (ctx, work, fallback) => {
		try {
			return await work(getResources());
		} catch (error) {
			stop(error, ctx);
			return fallback;
		}
	};
	registerSkills(pi, guard);
	registerSpills(pi, guard, registerDocs(pi, guard));
	registerClipboard(pi, guard);
}
