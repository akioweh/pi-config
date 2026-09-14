/**
 * Slash command `/move-dir <dir>` to move a session to another working directory.
 */

import { rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI) {
  // we need the session cwd (not necessarily `process.cwd()`) for the completion provider,
  // but no `ctx` is passed to `getArgumentCompletions`...
  let cwd = process.cwd();
  pi.on("session_start", (_event, ctx) => { cwd = ctx.cwd; });

  const dummySignal = new AbortController().signal;

  pi.registerCommand("move-dir", {
    description: "Move the current session to a different working directory",
    getArgumentCompletions: async (prefix) => {
      const provider = new CombinedAutocompleteProvider(undefined, cwd);
      const suggestions = await provider.getSuggestions([prefix], 0, prefix.length, {
        signal: dummySignal,
        force: true,
      });
      // filter to only keep directories (the completion provider does not discriminate)
      return (suggestions?.items ?? []).filter((item) => item.label.endsWith("/"));
    },
    handler: async (args, ctx) => {
      const source = ctx.sessionManager.getSessionFile();
      if (!source) {
        ctx.ui.notify("Ephemeral session: nothing to move.", "warning");
        return;
      }

      const input =
        args.trim() || (await ctx.ui.input("Move session to directory:", ctx.cwd))?.trim();
      if (!input) return;
      const dest = resolve(ctx.cwd, input.replace(/^~(?=$|[\\/])/, homedir()));
      if (dest === ctx.cwd) {
        ctx.ui.notify("Session is already in this directory.", "info");
        return;
      }

      if (!statSync(dest, { throwIfNoEntry: false })?.isDirectory()) {
        ctx.ui.notify(`Destination directory does not exist: ${dest}`, "error");
        return;
      }

      let moved: string;
      try {
        moved = SessionManager.forkFrom(source, dest).getSessionFile()!;
      } catch (error) {
        ctx.ui.notify(`Failed to move session: ${error instanceof Error ? error.message : String(error)}`, "error",);
        return;
      }

      const result = await ctx.switchSession(moved, {
        withSession: async (next) => {
          if (moved !== source) rmSync(source, { force: true });
          next.ui.notify(`Session moved to ${dest}`, "info");
        },
      });

      if (result.cancelled) {  // an event listener could cancel us...
        rmSync(moved, { force: true });
        ctx.ui.notify("Session move was cancelled.", "info");
      }
    },
  });
}
