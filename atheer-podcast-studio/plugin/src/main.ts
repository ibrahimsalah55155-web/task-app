/** UXP entry point: wires the panel lifecycle to PanelApp. */
import { UxpTokenStore } from "./companion/uxpTokenStore.ts";
import { logger } from "./core/log.ts";
import { PanelApp } from "./ui/app.ts";

declare const require: (id: string) => unknown;
const log = logger("main");

let app: PanelApp | null = null;

function mount(rootNode?: HTMLElement): void {
  if (app) return;
  const root = document.getElementById("app") ?? rootNode ?? document.body;
  try {
    app = new PanelApp(root, new UxpTokenStore());
    app.start();
  } catch (e) {
    log.error("Panel failed to start", e);
    root.textContent = `Multimedia & AI Group panel failed to start: ${String((e as Error)?.message ?? e)}`;
  }
}

interface Entrypoints {
  setup(config: unknown): void;
}

const uxp = require("uxp") as { entrypoints: Entrypoints };
uxp.entrypoints.setup({
  panels: {
    studioPanel: {
      create(rootNode: HTMLElement) {
        mount(rootNode);
      },
      show(rootNode: HTMLElement) {
        mount(rootNode);
        app?.setVisible(true);
      },
      hide() {
        app?.setVisible(false);
      },
      destroy() {
        app?.destroy();
        app = null;
      },
    },
  },
});
