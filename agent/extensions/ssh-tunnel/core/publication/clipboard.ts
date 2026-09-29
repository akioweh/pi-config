import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { platform } from "node:os";
import { convertToPng, CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getNativeClipboard } from "@earendil-works/pi-tui";
import type { Resources } from "../resources.ts";
import type { Guard } from "./index.ts";

interface Clipboard {
	readClipboardFilePaths(): Promise<string[] | null>;
	readClipboardText(): Promise<string | null>;
}
interface Images {
	readClipboardImage(): Promise<{ bytes: Uint8Array; mimeType: string } | null>;
	extensionForImageMimeType(mime: string): string | null;
}
type Editor = Pick<CustomEditor, "getText" | "getCursor" | "insertTextAtCursor">;

const imageExtensions: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif",
};

function baseMime(mime: string): string {
	return mime.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

export function extensionForImageMimeType(mime: string): string | null {
	return imageExtensions[baseMime(mime)] ?? null;
}

function runCommand(command: string, args: string[], timeoutMs = 3000): Promise<Buffer | undefined> {
	return new Promise((resolve) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
		const chunks: Buffer[] = [];
		let settled = false;
		const finish = (result?: Buffer) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish();
		}, timeoutMs);
		child.on("error", () => finish());
		child.on("close", (code) => finish(code === 0 ? Buffer.concat(chunks) : undefined));
		child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
	});
}

function pickImageType(raw: Buffer): string | null {
	const types = raw
		.toString("utf8")
		.split(/\r?\n/)
		.map((t) => t.trim())
		.filter(Boolean);
	for (const preferred of Object.keys(imageExtensions)) {
		const match = types.find((t) => baseMime(t) === preferred);
		if (match) return match;
	}
	return types.find((t) => baseMime(t).startsWith("image/")) ?? null;
}

function sniffImageMime(bytes: Uint8Array): string {
	if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "image/gif";
	if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57)
		return "image/webp";
	return "application/octet-stream";
}

export async function readClipboardFilePaths(): Promise<string[] | null> {
	const paths = await getNativeClipboard()?.getFilePaths?.();
	return paths?.length ? paths : null;
}

export async function readClipboardText(): Promise<string | null> {
	const commands: [string, string[]][] = [];
	if (process.env.TERMUX_VERSION) commands.push(["termux-clipboard-get", []]);
	if (platform() === "linux") {
		if (process.env.WAYLAND_DISPLAY) commands.push(["wl-paste", ["--no-newline", "--type", "text"]]);
		if (process.env.DISPLAY)
			commands.push(["xclip", ["-selection", "clipboard", "-out"]], ["xsel", ["--clipboard", "--output"]]);
	}
	for (const [command, args] of commands) {
		const bytes = await runCommand(command, args, 5000);
		if (bytes !== undefined) return bytes.toString("utf8") || null;
	}
	return (await getNativeClipboard()?.getText().catch(() => null)) || null;
}

export async function readClipboardImage(): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
	if (process.env.TERMUX_VERSION) return null;
	let image: { bytes: Uint8Array; mimeType: string } | null | undefined;
	if (platform() === "linux") {
		const backends: [boolean, string, string[], (type: string) => string[]][] = [
			[
				Boolean(process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === "wayland"),
				"wl-paste",
				["--list-types"],
				(type) => ["--type", type, "--no-newline"],
			],
			[
				Boolean(process.env.DISPLAY),
				"xclip",
				["-selection", "clipboard", "-t", "TARGETS", "-o"],
				(type) => ["-selection", "clipboard", "-t", type, "-o"],
			],
		];
		for (const [enabled, command, listArgs, readArgs] of backends) {
			if (!enabled || image !== undefined) continue;
			const list = await runCommand(command, listArgs, 1000);
			if (list === undefined) continue;
			const type = pickImageType(list);
			const data = type ? await runCommand(command, readArgs(type)) : null;
			image = data === undefined ? undefined : data?.length ? { bytes: data, mimeType: baseMime(type!) } : null;
		}
	}
	if (image === undefined) {
		const bytes = await getNativeClipboard()?.getImage().catch(() => null);
		image = bytes?.length ? { bytes, mimeType: sniffImageMime(bytes) } : null;
	}
	if (!image) return null;
	if (!extensionForImageMimeType(image.mimeType)) {
		const converted = await convertToPng(Buffer.from(image.bytes).toString("base64"), image.mimeType).catch(() => null);
		return converted ? { bytes: new Uint8Array(Buffer.from(converted.data, "base64")), mimeType: converted.mimeType } : null;
	}
	return image;
}

const defaultClipboard: Clipboard = { readClipboardFilePaths, readClipboardText };
const defaultImages: Images = { readClipboardImage, extensionForImageMimeType };

export async function pasteClipboard(
	resources: Resources,
	editor: Editor,
	clipboard: Clipboard = defaultClipboard,
	images: Images = defaultImages,
): Promise<void> {
	const paths = await clipboard.readClipboardFilePaths();
	const targets: string[] = [];
	let insertion = "";
	if (paths?.length) {
		if (paths.some((path) => /\p{Cc}/u.test(path))) throw new Error("Clipboard file path contains control characters");
		for (const path of paths) {
			const info = await stat(path);
			if (!info.isDirectory() && !info.isFile()) throw new Error(`Unsupported clipboard file: ${path}`);
			targets.push(await (info.isDirectory() ? resources.publishDirectory(path) : resources.publishFile(path)));
		}
	} else {
		const image = await images.readClipboardImage();
		if (image) {
			targets.push(
				await resources.publishData(
					image.bytes,
					`clipboard.${images.extensionForImageMimeType(image.mimeType) ?? "png"}`,
				),
			);
		} else insertion = (await clipboard.readClipboardText()) ?? "";
	}
	if (targets.length) {
		insertion = editor.getText().trimStart().startsWith("!")
			? targets.map((path) => `'${path.replaceAll("'", "'\\''")}'`).join(" ")
			: targets.join("\n");
		const cursor = editor.getCursor();
		const line = editor.getText().split("\n")[cursor.line] ?? "";
		if (cursor.col > 0 && !/\s/.test(line[cursor.col - 1])) insertion = ` ${insertion}`;
		if (line[cursor.col] && !/\s/.test(line[cursor.col])) insertion += " ";
	}
	if (insertion) editor.insertTextAtCursor(insertion);
}

/** Own paste before a filename loses its local provenance, using only public Pi/TUI exports. */
export function registerClipboard(pi: ExtensionAPI, guard: Guard): void {
	let restore: (() => void) | undefined;
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		await guard(ctx, async () => {
			const previous = ctx.ui.getEditorComponent();
			const factory: typeof previous = (tui, theme, keys) => {
				const component = previous?.(tui, theme, keys) ?? new CustomEditor(tui, theme, keys);
				if (!("actionHandlers" in component) || !(component.actionHandlers instanceof Map)) {
					void guard(ctx, async () => {
						throw new Error("SSH-forwarded paste requires a CustomEditor-compatible editor");
					});
					return component;
				}
				const editor = component as CustomEditor;
				editor.onPasteImage = () => {
					void guard(ctx, async (resources) => {
						await pasteClipboard(resources, editor);
						tui.requestRender();
					});
				};
				return editor;
			};
			restore = () => {
				if (ctx.ui.getEditorComponent() === factory) ctx.ui.setEditorComponent(previous);
			};
			ctx.ui.setEditorComponent(factory);
		});
	});
	pi.on("session_shutdown", () => {
		restore?.();
		restore = undefined;
	});
}
