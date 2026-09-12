/**
 * Cursor focus indication.
 *
 * We want to reflect the focus state of the Pi instance via the appearance of the cursor.
 * Specifically, we're inspired by Kitty's default behavior: regular block cursor when focused,
 * and a hollow block when unfocused.
 *
 * Pi normally renders a "fake"/software cursor as a "reverse video" cell (and hides the hardware cursor).
 *
 * When unfocused, we reveal the hardware cursor and un-render the soft one, therefore letting the terminal'
 * configuration determine the appearance of the unfocused cursor state.
 *
 * For Kitty, this needs `cursor_shape_unfocused hollow` (true hollow on OS-window blur);
 * In tmux, we also need `set -g focus-events on`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, type TUI } from "@earendil-works/pi-tui";

// Pi's software cursor is CURSOR_MARKER immediately followed by reverse video (ESC[7m ... ESC[0m). 
// Keep the marker for position (of the hardware cursor) but drop the reverse video to not overlay the hardware cursor.
const SOFT_CURSOR = /\u001b_pi:c\u0007\x1b\[7m(.*?)\x1b\[0m/gu;

class FocusCursorEditor extends CustomEditor {
  terminalFocused = true;

  override render(width: number): string[] {
    const lines = super.render(width);
    if (this.terminalFocused) return lines;
    return lines.map((line) => line.replace(SOFT_CURSOR, (_match, char: string) => CURSOR_MARKER + char));
  }
}

export default function (pi: ExtensionAPI) {
  let tui: TUI | undefined;
  let editor: FocusCursorEditor | undefined;
  let focused = true;
  let carry = "";

  const write = (data: string) => (tui ? tui.terminal.write(data) : process.stdout.write(data));

  const setFocused = (next: boolean) => {
    if (next === focused) return;
    focused = next;
    if (editor) editor.terminalFocused = next;
    tui?.setShowHardwareCursor(!next);
    tui?.requestRender();
    write(next ? "\x1b[0 q" : "\x1b[4 q");
  };

  // raw stdin tap (required to capture CSI I/O even in full screen rendering mode)
  const onStdin = (data: string | Buffer) => {
    const text = carry + (typeof data === "string" ? data : data.toString("utf8"));
    const inAt = text.lastIndexOf("\x1b[I");
    const outAt = text.lastIndexOf("\x1b[O");
    if (inAt !== -1 || outAt !== -1) setFocused(inAt > outAt);
    carry = text.slice(-2);
  };

  const teardown = () => {
    process.stdin.removeListener("data", onStdin);
    write("\x1b[?1004l");
    write("\x1b[0 q");
    tui?.setShowHardwareCursor(false);
    editor = undefined;
    tui = undefined;
  };

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    teardown();
    focused = true;
    carry = "";

    ctx.ui.setEditorComponent((nextTui, theme, keybindings) => {
      tui = nextTui;
      editor = new FocusCursorEditor(nextTui, theme, keybindings, { embedWorkingStatus: true });
      editor.terminalFocused = focused;
      return editor;
    });

    write("\x1b[?1004h");
    write("\x1b[0 q");
    process.stdin.prependListener("data", onStdin);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setEditorComponent(undefined);
    teardown();
  });
}
