/** Project-local session lifecycle; tool and transport details live in their adapters. */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerPublication } from "./publication/index.ts";
import { Remote } from "./remote.ts";
import { Resources } from "./resources.ts";
import { getTarget } from "./session.ts";
import { registerTools } from "./tools.ts";

async function authenticate(args: string[], ctx: ExtensionContext): Promise<void> {
	// Hand the terminal to SSH for its normal password and host-key prompts.
	const error = await ctx.ui.custom<string | undefined>((tui, _theme, _keys, done) => {
		tui.stop();
		let error: string | undefined;
		try {
			const result = spawnSync("ssh", args, { stdio: "inherit" });
			if (result.status !== 0) error = result.error?.message ?? `SSH authentication failed (${result.status})`;
		} finally {
			tui.start();
		}
		tui.requestRender(true);
		done(error);
		return { render: () => [], invalidate() {} };
	});
	if (error) throw new Error(error);
}

export default function (pi: ExtensionAPI) {
	let remote: Remote | undefined;
	let failure: Error | undefined;
	let resources: Resources | undefined;
	let agentInstructions: Awaited<ReturnType<Remote["readAgentInstructions"]>> = [];
	const requireRemote = () => {
		if (failure) throw failure;
		if (!remote) throw new Error("SSH is not connected");
		return remote;
	};

	pi.on("session_before_switch", (event, ctx) => {
		if (event.reason !== "new") return;
		ctx.ui.notify(
			"Use /ssh to start a new session on this remote, or /ssh user@host[:path] for another target.",
			"info",
		);
		return { cancel: true };
	});
	pi.on("session_before_fork", (_event, ctx) => {
		const path = ctx.sessionManager.getSessionFile();
		if (path && existsSync(path)) return;
		ctx.ui.notify(
			"This session is not saved yet. Send a message before forking, or use /ssh for a fresh session.",
			"info",
		);
		return { cancel: true };
	});
	pi.on("session_start", async (_event, ctx) => {
		registerTools(pi, ctx, requireRemote);
		try {
			const target = getTarget(ctx.sessionManager);
			remote = await Remote.connect(target, ctx.mode === "tui" ? (args) => authenticate(args, ctx) : undefined);
			resources = new Resources(remote, await remote.temporaryDirectory());
			agentInstructions = await remote.readAgentInstructions((message) => ctx.ui.notify(message, "warning"));
			const resolvedTarget = `${remote.host}:${remote.cwd}`;
			if (!pi.getSessionName()) pi.setSessionName(`SSH: ${resolvedTarget}`);
			ctx.ui.setStatus("ssh", ctx.ui.theme.fg("accent", `SSH: ${resolvedTarget}`));
			ctx.ui.notify(
				`SSH: ${resolvedTarget}. read/write/edit/bash are forwarded; use bash for searches. /ssh starts a new SSH-forwarded session.`,
				"info",
			);
		} catch (error) {
			failure = error instanceof Error ? error : new Error(String(error));
			ctx.ui.setStatus("ssh", ctx.ui.theme.fg("error", "SSH unavailable"));
			ctx.ui.notify(failure.message, "error");
		}
	});
	pi.on("user_bash", () => ({
		operations: { exec: (...args) => requireRemote().bash.exec(...args) },
	}));
	pi.on("session_shutdown", async () => {
		await remote?.close();
	});

	pi.on("before_agent_start", (event) => {
		if (!remote || failure) return;
		event.systemPromptOptions.cwd = remote.cwd;
		event.systemPromptOptions.contextFiles.push(...agentInstructions);
	});
	registerPublication(
		pi,
		() => {
			requireRemote();
			if (!resources) throw new Error("SSH resource publication is not ready");
			return resources;
		},
		(error, ctx) => {
			if (!ctx.signal?.aborted && !failure) {
				failure = error instanceof Error ? error : new Error(String(error));
				ctx.ui.setStatus("ssh", ctx.ui.theme.fg("error", "SSH publication stopped"));
				ctx.ui.notify(`SSH-forwarding stopped: ${failure.message}. Reload before continuing.`, "error");
			}
			ctx.abort();
		},
	);
}
