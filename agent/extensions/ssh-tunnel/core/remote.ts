/** SSH transport and the small filesystem/shell operations pi cannot do locally. */
import { execFile, spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import type { BashOperations, EditOperations, WriteOperations } from "@earendil-works/pi-coding-agent";

import { parseTarget } from "./paths.ts";

function quote(value: string): string {
	if (value.includes("\0")) throw new Error("SSH arguments cannot contain NUL bytes");
	return "'" + value.replaceAll("'", "'\\''") + "'";
}

interface RunOptions {
	input?: string | Buffer | Readable;
	hold?: boolean;
	onData?: (chunk: Buffer) => void;
	signal?: AbortSignal;
	timeout?: number;
}

export class Remote {
	cwd = "";
	home = "";
	private shell = "sh";
	private closed = false;
	private readonly options: string[];
	readonly host: string;
	private readonly controlDir: string;

	private constructor(host: string, controlDir: string) {
		this.host = host;
		this.controlDir = controlDir;
		this.options = [
			"-T",
			"-oRemoteCommand=none",
			"-oConnectTimeout=10",
			"-oServerAliveInterval=15",
			"-oServerAliveCountMax=2",
			"-oControlMaster=auto",
			`-oControlPath=${join(controlDir, "socket")}`,
			"-oControlPersist=60",
		];
	}

	static async connect(target: string, authenticate?: (args: string[]) => Promise<void>): Promise<Remote> {
		const { host, path } = parseTarget(target);
		const remote = new Remote(host, await mkdtemp(join(tmpdir(), "pi-ssh-")));
		try {
			if (authenticate) await authenticate([...remote.options, "-oBatchMode=no", "--", host, "true"]);
			const dir = path === "~" ? '"$HOME"' : path.startsWith("~/") ? `"$HOME"/${quote(path.slice(2))}` : quote(path);
			const probe = await remote.checked(
				`cd -- ${dir} && printf '%s\\0' "$HOME" "$PWD" "$(command -v bash || command -v sh)"`,
				{ timeout: 20 },
			);
			const [home, cwd, shell] = probe.toString().split("\0");
			if (!home?.startsWith("/") || !cwd?.startsWith("/") || !shell)
				throw new Error("Could not determine remote HOME, cwd, and shell");
			remote.home = home;
			remote.cwd = cwd;
			remote.shell = shell;
			return remote;
		} catch (error) {
			await remote.close();
			throw error;
		}
	}

	private run(command: string, options: RunOptions = {}): Promise<{ code: number; stdout: Buffer; stderr: string }> {
		if (this.closed) return Promise.reject(new Error("SSH connection is closed"));
		// These two messages are pi's BashOperations cancellation/timeout contract.
		if (options.signal?.aborted) return Promise.reject(new Error("aborted"));
		return new Promise((resolve, reject) => {
			const child = spawn("ssh", [...this.options, "-oBatchMode=yes", "--", this.host, command], { stdio: "pipe" });
			const out: Buffer[] = [],
				err: Buffer[] = [];
			let timedOut = false;
			const abort = () => child.kill();
			const timer =
				options.timeout === undefined
					? undefined
					: setTimeout(() => {
							timedOut = true;
							child.kill();
						}, options.timeout * 1000);
			options.signal?.addEventListener("abort", abort, { once: true });
			const cleanup = () => {
				clearTimeout(timer);
				options.signal?.removeEventListener("abort", abort);
			};
			child.stdout.on("data", (chunk: Buffer) => (options.onData ? options.onData(chunk) : out.push(chunk)));
			child.stderr.on("data", (chunk: Buffer) => (options.onData ? options.onData(chunk) : err.push(chunk)));
			// Distinguish local source read errors from EPIPE when the remote command exits early.
			child.stdin?.on("error", () => {});
			let inputError: Error | undefined;
			let streamError: Error | undefined;
			if (options.input instanceof Readable) {
				options.input.on("error", (error: Error) => {
					inputError = error;
				});
			}
			const transfer =
				options.input instanceof Readable
					? pipeline(options.input, child.stdin).catch((error: Error) => {
							streamError = error;
							child.kill();
						})
					: Promise.resolve();
			if (!options.hold && !(options.input instanceof Readable)) child.stdin.end(options.input);
			child.on("error", (error) => {
				cleanup();
				reject(error);
			});
			child.on("close", async (code) => {
				cleanup();
				await transfer;
				if (options.signal?.aborted) reject(new Error("aborted"));
				else if (timedOut) reject(new Error(`timeout:${options.timeout}`));
				else if (inputError) reject(inputError);
				else if (streamError && (code === 0 || code === null)) reject(streamError);
				else
					resolve({
						code: code ?? 255,
						stdout: Buffer.concat(out),
						stderr: Buffer.concat(err).toString(),
					});
			});
		});
	}

	private async checked(command: string, options?: RunOptions): Promise<Buffer> {
		const result = await this.run(command, options);
		if (result.code !== 0) throw new Error(`SSH command failed (${result.code}): ${result.stderr.trim() || command}`);
		return result.stdout;
	}

	async temporaryDirectory(signal?: AbortSignal): Promise<string> {
		const path = (
			await this.checked(`umask 077; mktemp -d "\${TMPDIR:-/tmp}/pi-resources-XXXXXXXX"`, {
				signal,
				timeout: 30,
			})
		)
			.toString()
			.trim();
		if (!path.startsWith("/")) throw new Error("SSH temporary directory is not absolute");
		return path;
	}

	private async upload(localPath: string, command: string, signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		const input = createReadStream(localPath);
		try {
			await this.checked(command, {
				input,
				signal,
				timeout: 60,
			});
		} finally {
			input.destroy();
		}
	}

	uploadFile(localPath: string, path: string, mode: number, signal?: AbortSignal): Promise<void> {
		return this.upload(
			localPath,
			`umask 077; cat > ${quote(path)} && chmod ${mode.toString(8)} ${quote(path)}`,
			signal,
		);
	}

	extractArchive(localPath: string, directory: string, signal?: AbortSignal): Promise<void> {
		// shortcut: assumes remote tar supports --no-same-owner, probe or drop flag if targeting minimal POSIX tar.
		return this.upload(
			localPath,
			`umask 077; mkdir -p ${quote(directory)} && tar --no-same-owner -xpf - -C ${quote(directory)}`,
			signal,
		);
	}

	async makeDirectory(path: string, signal?: AbortSignal): Promise<void> {
		await this.checked(`umask 077; mkdir -p ${quote(path)}`, { signal, timeout: 30 });
	}

	readFile(path: string, signal?: AbortSignal): Promise<Buffer> {
		return this.checked(`cat ${quote(path)}`, { signal });
	}

	async readAgentInstructions(
		onWarning: (message: string) => void = console.warn,
	): Promise<Array<{ path: string; content: string }>> {
		// Match Pi's per-directory precedence and root-to-cwd inheritance.
		const script = [
			`directory=${quote(this.cwd)}`,
			"while :; do",
			"  for file in AGENTS.override.md AGENTS.md AGENTS.MD CLAUDE.md CLAUDE.MD; do",
			'    path="${directory%/}/$file"',
			'    if [ -f "$path" ]; then printf \'%s\\0\' "$path"; fi',
			"  done",
			'  [ "$directory" = / ] && break',
			"  directory=${directory%/*}; directory=${directory:-/}",
			"done",
		].join("\n");
		const paths = (await this.checked(script, { timeout: 20 })).toString().split("\0").filter(Boolean);
		const files: Array<{ path: string; content: string }> = [];
		let loadedDirectory: string | undefined;
		for (const path of paths) {
			const directory = posix.dirname(path);
			if (directory === loadedDirectory) continue;
			const result = await this.run(`cat ${quote(path)}`, { timeout: 20 });
			// OpenSSH uses 255 for transport failures; cat failures allow a fallback.
			if (result.code === 255) throw new Error(`SSH command failed (255): ${result.stderr.trim()}`);
			if (result.code !== 0) {
				onWarning(`Could not read ${path}: ${result.stderr.trim() || `exit ${result.code}`}`);
				continue;
			}
			files.unshift({
				path,
				content: result.stdout.toString().replace(/^\uFEFF/, ""),
			});
			loadedDirectory = directory;
		}
		return files;
	}

	readonly files: EditOperations & WriteOperations = {
		readFile: (path) => this.readFile(path),
		writeFile: async (path, content) => {
			await this.checked(`cat > ${quote(path)}`, { input: content });
		},
		mkdir: async (path) => {
			await this.checked(`mkdir -p ${quote(path)}`);
		},
		access: async (path) => {
			await this.checked(`[ -r ${quote(path)} ] && [ -w ${quote(path)} ]`);
		},
	};

	readonly bash: BashOperations = {
		exec: async (command, _cwd, { onData, signal, timeout, env }) => {
			// OpenSSH creates a separate session/group per remote command. The watcher
			// inherits that group: kill 0 targets it without assuming PID == PGID.
			// No job control, PTY, setsid utility, PID discovery, or extra connection.
			const wrapper = [
				"set +m",
				"exec 9<&0",
				'cd -- "$1" || exit 1',
				`${quote(this.shell)} -c "$2" < /dev/null &`,
				"command_pid=$!",
				"(while IFS= read -r line <&9; do :; done; kill -s KILL 0) &",
				"watcher_pid=$!",
				"wait $command_pid; status=$?",
				"kill $watcher_pid 2>/dev/null",
				'exit "$status"',
			].join("\n");
			// Only pi's session metadata crosses machines, not local credentials/PATH.
			const exports = ["PI_SESSION_ID", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"]
				.filter((key) => env?.[key] !== undefined)
				.map((key) => `export ${key}=${quote(env![key]!)}; `)
				.join("");
			const result = await this.run(`sh -c ${quote(wrapper)} sh ${quote(this.cwd)} ${quote(exports + command)}`, {
				hold: true,
				onData,
				signal,
				timeout,
			});
			return { exitCode: result.code };
		},
	};

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		try {
			await promisify(execFile)("ssh", [...this.options, "-O", "exit", "--", this.host], { timeout: 5000 });
		} catch {
			/* Already disconnected, or setup never created the master. */
		} finally {
			await rm(this.controlDir, { recursive: true, force: true });
		}
	}
}
