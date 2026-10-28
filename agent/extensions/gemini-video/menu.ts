import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { getSelectListTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, SelectList, Text } from "@earendil-works/pi-tui";
import { loadSettings, MODEL_THINKING, saveSettings, type Settings, type Thinking, type VideoModel } from "./core.ts";

export async function showMenu(ctx: ExtensionContext, path: string): Promise<void> {
  if (ctx.mode !== "tui") throw new Error("/gemini-video requires Pi's interactive TUI.");
  let settings = await loadSettings(path);
  const models = ctx.modelRegistry.getAvailable().filter((model) => model.provider === "google"
    && Object.hasOwn(MODEL_THINKING, model.id));
  if (!models.length) throw new Error("No compatible Gemini models available. Configure Google Gemini with /login first.");
  const thinking = (id: VideoModel): Thinking[] => {
    const model = models.find((candidate) => candidate.id === id);
    return model ? getSupportedThinkingLevels(model).filter((level): level is Thinking =>
      (MODEL_THINKING[id] as readonly string[]).includes(level)) : [];
  };
  await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
    let tab = 0;
    let saving = false;
    let list: SelectList;
    const header = new Text("", 0, 0);
    const panel = new Container();
    const container = new Container();
    container.addChild(header);
    container.addChild(panel);
    container.addChild(new Text(theme.fg("dim", "Tab/Shift+Tab switch · Enter save selection · Esc close"), 0, 0));
    const rebuild = () => {
      const labels = [`Model: ${settings.model}`, `Thinking: ${settings.thinkingLevel}`, `Resolution: ${settings.mediaResolution}`];
      header.setText(labels.map((label, index) => index === tab
        ? theme.fg("accent", theme.bold(label)) : theme.fg("muted", label)).join("  ") + "\n");
      const items = tab === 0 ? models.map((model) => ({ value: model.id, label: model.name }))
        : (tab === 1 ? thinking(settings.model) : ["default", "low", "medium", "high"])
          .map((value) => ({ value, label: value }));
      const selected = [settings.model, settings.thinkingLevel, settings.mediaResolution][tab];
      list = new SelectList(items.map((item) => ({ ...item, label: `${item.value === selected ? "✓ " : "  "}${item.label}` })), 8, getSelectListTheme());
      list.setSelectedIndex(Math.max(0, items.findIndex((item) => item.value === selected)));
      list.onSelect = (item) => {
        saving = true;
        const next: Settings = { ...settings };
        if (tab === 0) {
          next.model = item.value as VideoModel;
          const levels = thinking(next.model);
          if (!levels.length) {
            saving = false;
            ctx.ui.notify("No compatible thinking levels for this model.", "error");
            return;
          }
          if (!levels.includes(next.thinkingLevel)) next.thinkingLevel = levels.includes("medium") ? "medium" : levels[0];
        } else if (tab === 1) next.thinkingLevel = item.value as Thinking;
        else next.mediaResolution = item.value as Settings["mediaResolution"];
        void saveSettings(path, next).then(() => {
          settings = next;
          rebuild();
        }).catch((error) => ctx.ui.notify(String(error), "error")).finally(() => {
          saving = false;
          tui.requestRender();
        });
      };
      list.onCancel = () => done();
      panel.clear();
      panel.addChild(list);
    };
    rebuild();
    return {
      render: (width) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput(data) {
        if (saving) return;
        if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
          tab = (tab + (matchesKey(data, Key.tab) ? 1 : 2)) % 3;
          rebuild();
        } else if (keybindings.matches(data, "tui.select.cancel")) done();
        else list.handleInput(data);
        tui.requestRender();
      },
    };
  });
}
