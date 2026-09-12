/**
 * Rings BEL whenever Pi needs user attention
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("agent_settled", async (_event, ctx) => {
    if (ctx.mode === "tui") process.stdout.write("\x07");
  });

  pi.on("ui_prompt_start", async (_event, ctx) => {
    if (ctx.mode === "tui") process.stdout.write("\x07");
  });
}
