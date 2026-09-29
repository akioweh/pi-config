import {
	createBashToolDefinition,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandRemoteHome, resolveRemoteReadPath } from "./paths.ts";
import type { Remote } from "./remote.ts";

export function registerTools(pi: ExtensionAPI, ctx: ExtensionContext, getRemote: () => Remote): void {
	const { cwd } = ctx;
	const active = pi.getActiveTools();
	const read = createReadToolDefinition(cwd);
	pi.registerTool({
		...read,
		async execute(id, args, signal, onUpdate, context) {
			const r = getRemote();
			// Stage bytes locally so pi owns text/image detection and processing.
			const temp = await mkdtemp(join(tmpdir(), "pi-ssh-read-"));
			try {
				const path = join(temp, "content");
				await writeFile(path, await r.readFile(resolveRemoteReadPath(args.path, r.cwd, r.home), signal));
				return await read.execute(id, { ...args, path }, signal, onUpdate, context);
			} finally {
				await rm(temp, { recursive: true, force: true });
			}
		},
	});

	const files: Remote["files"] = {
		readFile: (...args) => getRemote().files.readFile(...args),
		writeFile: (...args) => getRemote().files.writeFile(...args),
		mkdir: (...args) => getRemote().files.mkdir(...args),
		access: (...args) => getRemote().files.access(...args),
	};
	const write = createWriteToolDefinition(cwd, { operations: files });
	pi.registerTool({
		...write,
		execute(id, args, signal, onUpdate, context) {
			const r = getRemote();
			return write.execute(id, { ...args, path: expandRemoteHome(args.path, r.home) }, signal, onUpdate, {
				...context,
				cwd: r.cwd,
			});
		},
	});
	const edit = createEditToolDefinition(cwd, { operations: files });
	pi.registerTool({
		...edit,
		execute(id, args, signal, onUpdate, context) {
			const r = getRemote();
			return edit.execute(id, { ...args, path: expandRemoteHome(args.path, r.home) }, signal, onUpdate, {
				...context,
				cwd: r.cwd,
			});
		},
	});
	const bash = createBashToolDefinition(cwd, {
		operations: { exec: (...args) => getRemote().bash.exec(...args) },
	});
	pi.registerTool({
		...bash,
		execute(id, args, signal, onUpdate, context) {
			return bash.execute(id, args, signal, onUpdate, {
				...context,
				cwd: getRemote().cwd,
			});
		},
	});

	const unsupported = new Set(["ls", "find", "grep", "powershell"]);
	const disabled = active.filter((name) => unsupported.has(name));
	pi.setActiveTools(active.filter((name) => !unsupported.has(name)));
	if (disabled.length) ctx.ui.notify(`Disabled tools: ${disabled.join(", ")}. Use bash instead.`, "warning");
	pi.on("tool_call", (event) => {
		if (unsupported.has(event.toolName))
			return { block: true, reason: `${event.toolName} is disabled; use bash instead` };
	});
}
