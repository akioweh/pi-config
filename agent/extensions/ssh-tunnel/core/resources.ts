import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, posix, relative, sep } from "node:path";
import { promisify } from "node:util";
import type { Remote } from "./remote.ts";

interface PublicationOptions {
	signal?: AbortSignal;
}

/** One ephemeral publication root per extension load. Old roots remain valid until temp cleanup. */
export class Resources {
	private readonly remote: Remote;
	readonly root: string;

	constructor(remote: Remote, root: string) {
		this.remote = remote;
		this.root = root;
	}

	async publishFile(localPath: string, { signal }: PublicationOptions = {}): Promise<string> {
		signal?.throwIfAborted();
		const directory = posix.join(this.root, randomBytes(8).toString("hex"));
		// Separate step avoids racing Pi's unawaited user-bash spill stream flush on immediate prompt.
		await this.remote.makeDirectory(directory, signal);
		const path = posix.join(directory, basename(localPath));
		await this.remote.uploadFile(localPath, path, 0o600, signal);
		return path;
	}

	async publishData(data: string | Uint8Array, name: string, options: PublicationOptions = {}): Promise<string> {
		const directory = await mkdtemp(join(tmpdir(), "pi-ssh-publish-"));
		try {
			const path = join(directory, basename(name));
			await writeFile(path, data, { mode: 0o600 });
			return await this.publishFile(path, options);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}

	publishDirectory(localPath: string, options: PublicationOptions = {}): Promise<string> {
		return this.publishEntries([[localPath, "."]], options);
	}

	/** Publish related files/directories as siblings so relative references keep working. */
	publishBundle(localPaths: string[], options: PublicationOptions = {}): Promise<string> {
		const names = localPaths.map((path) => basename(path));
		if (names.some((name) => !name || name === "." || name === "..") || new Set(names).size !== names.length)
			throw new Error("Resource bundle requires distinct filenames");
		return this.publishEntries(localPaths.map((path, index) => [path, names[index]]), options);
	}

	private async publishEntries(entries: [string, string][], { signal }: PublicationOptions): Promise<string> {
		signal?.throwIfAborted();
		const directory = await mkdtemp(join(tmpdir(), "pi-ssh-publish-"));
		try {
			const contents = join(directory, "contents");
			await mkdir(contents, { mode: 0o700 });
			for (const [path, name] of entries) {
				const source = await realpath(path);
				await this.stage(source, source, join(contents, name), new Set(), signal);
			}
			const archive = join(directory, "resources.tar");
			await promisify(execFile)("tar", ["-cf", archive, "-C", contents, "."], { signal });
			const destination = posix.join(this.root, randomBytes(8).toString("hex"));
			await this.remote.extractArchive(archive, destination, signal);
			return destination;
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}

	private async stage(
		root: string,
		source: string,
		destination: string,
		ancestors: Set<string>,
		signal?: AbortSignal,
	): Promise<void> {
		signal?.throwIfAborted();
		const info = await stat(source);
		if (info.isFile()) {
			await copyFile(source, destination);
			await chmod(destination, info.mode & 0o777);
			return;
		}
		if (!info.isDirectory()) throw new Error(`Unsupported resource: ${source}`);
		if (ancestors.has(source)) throw new Error(`Resource directory contains a symlink cycle: ${source}`);
		ancestors.add(source);
		try {
			await mkdir(destination, { recursive: true, mode: 0o700 });
			// Copy internal symlinks by value and reject any target that resolves outside root.
			for (const entry of await readdir(source)) {
				signal?.throwIfAborted();
				const path = await realpath(join(source, entry));
				const within = relative(root, path);
				if (isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`)) {
					throw new Error(`Resource symlink escapes its directory: ${join(source, entry)}`);
				}
				await this.stage(root, path, join(destination, entry), ancestors, signal);
			}
		} finally {
			ancestors.delete(source);
		}
	}
}
