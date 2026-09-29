/** SSH target syntax and the path adaptations pi's local tools cannot supply. */
import { posix } from "node:path";

export function parseTarget(target: string): { host: string; path: string } {
	const colon = target.indexOf(":");
	const host = colon < 0 ? target : target.slice(0, colon);
	if (!host || host.startsWith("-") || /\s/.test(host) || target.includes("\0"))
		throw new Error("Malformed SSH target; expected: user@host[:path]");
	return { host, path: colon < 0 ? "." : target.slice(colon + 1) };
}

/** Expand remote ~ before native tools would expand it against the local home.
 * Leave other paths alone: pi owns @ stripping, space normalization, and cwd resolution.
 */
export function expandRemoteHome(raw: string, home: string): string {
	if (raw.includes("\0")) throw new Error("Invalid path: contains NUL");
	const path = raw.replace(/^@/, "");
	if (path === "~") return home;
	if (path.startsWith("~/")) return home + path.slice(1);
	return raw;
}

/** Read fetches precede the native reader, so this path needs full normalization. */
export function resolveRemoteReadPath(raw: string, cwd: string, home: string): string {
	const spaces = raw.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
	return posix.resolve(cwd, expandRemoteHome(spaces, home).replace(/^@/, ""));
}
