import { SessionManager } from "@earendil-works/pi-coding-agent";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseTarget } from "./paths.ts";

export const TARGET_ENTRY_KEY = "ssh-tunnel-target";

/**
 * Extracts the SSH target (host + cwd) of the given SSH-forwarded session.
 */
export function getTarget(session: Pick<SessionManager, "getBranch">): string {
	const root = session.getBranch()[0];
	if (root?.type !== "custom" || root.customType !== TARGET_ENTRY_KEY) throw new Error("Missing saved SSH target");
	const data = root.data;
	if (!data || typeof data !== "object" || !("target" in data) || typeof data.target !== "string")
		throw new Error("Invalid saved SSH target");
	parseTarget(data.target);
	return data.target;
}

/**
 * Creates a session with SSH-forwarding enabled;
 * returns its JSONL file path.
 */
export async function newForwardedSession(workspace: string, target: string): Promise<string> {
	parseTarget(target);
	const session = SessionManager.create(workspace, join(workspace, "sessions"));
	session.appendCustomEntry(TARGET_ENTRY_KEY, { target });
	session.appendSessionInfo(`SSH: ${target}`);
	const path = session.getSessionFile()!;

	// there is no public API to materialize/persist a session... this mirrors SessionManager#_rewriteFile()
	const entries = [session.getHeader(), ...session.getEntries()];
	await writeFile(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", {
		flag: "wx",
		mode: 0o600,
	});

	return path;
}
