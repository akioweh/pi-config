/**
 * This is the always-loaded shim that provides the /ssh command.
 * It also initializes the dedicated session storage directory on first use.
 */
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, readlink, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { parseTarget } from "./core/paths.ts";
import { newForwardedSession, getTarget } from "./core/session.ts";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("ssh", {
		description: "Start a new remote session: /ssh user@host[:path] (omit argument to use this session's)",
		handler: async (args, ctx) => {
			let target = args.trim();
			if (!target) {
				try {
					target = getTarget(ctx.sessionManager);
				} catch {
					// current session has no host + path info to default to; require passing via command
					ctx.ui.notify("Usage: /ssh user@host[:path]", "info");
					return;
				}
			}
			parseTarget(target);
			if (!ctx.sessionManager.getSessionFile())
				throw new Error("/ssh does not work with ephemeral sessions; did you run Pi with --no-session?");
			await ctx.waitForIdle();

			const sessionStorePath = await ensureStoreDir();
			const path = await newForwardedSession(sessionStorePath, target);
			const result = await ctx.switchSession(path);
			if (result.cancelled) await rm(path);
		},
	});
}

/**
 * Creates (idempotently) the dedicated session store directory
 * and ensures this extension is linked into its extensions dir.
 *
 * Returns the store's path.
 */
async function ensureStoreDir(): Promise<string> {
	const sessionStorePath = join(getAgentDir(), "ssh-workspace");
	const sessionStoreExtensionsPath = join(sessionStorePath, CONFIG_DIR_NAME, "extensions");
	await mkdir(sessionStoreExtensionsPath, { recursive: true });

	const installPath = join(sessionStoreExtensionsPath, "ssh-tunnel");
	const sourcePath = join(import.meta.dirname, "core");
	const existingLink = await readlink(installPath).catch(() => undefined);
	if (existingLink !== undefined && existingLink !== sourcePath)
		throw new Error(`SSH extension link already points elsewhere: ${installPath}`);
	if (existingLink === undefined) {
		try {
			await symlink(sourcePath, installPath, "dir");
		} catch (error) {
			throw new Error("extension setup installation failed", { cause: error });
		}
	}

	return sessionStorePath;
}
