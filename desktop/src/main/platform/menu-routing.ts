// Routes application-menu actions to the right window. The menu is global,
// but the Terminal window must close, zoom and reload itself; main-window
// actions chosen while it has focus bring the main window forward first.
import { nextZoomFactor, type ZoomAction } from "./zoom";

interface MenuWindow {
  isDestroyed(): boolean;
  isFocused(): boolean;
  close(): void;
  webContents: {
    send(channel: string, payload: unknown): void;
    reload(): void;
    getZoomFactor(): number;
    setZoomFactor(factor: number): void;
  };
}

export interface MenuRouterOptions {
  mainWindow(): MenuWindow | null;
  terminalWindow(): MenuWindow | null;
  focusMain(): void;
}

function live(win: MenuWindow | null): MenuWindow | null {
  return win && !win.isDestroyed() ? win : null;
}

function isCloseTab(channel: string, payload: unknown): boolean {
  return channel === "menu:action" && (payload as { action?: unknown } | null)?.action === "close-tab";
}

export function createMenuRouter(options: MenuRouterOptions) {
  const focusedTerminal = (): MenuWindow | null => {
    const win = live(options.terminalWindow());
    return win?.isFocused() ? win : null;
  };
  const main = (): MenuWindow | null => live(options.mainWindow());

  return {
    send(channel: string, payload: unknown): void {
      const terminal = focusedTerminal();
      if (terminal && isCloseTab(channel, payload)) {
        terminal.close();
        return;
      }
      const target = main();
      if (!target) return;
      if (terminal) options.focusMain();
      target.webContents.send(channel, payload);
    },

    // Menu zoom steps apply immediately; only the main renderer persists them.
    adjustZoom(action: ZoomAction): void {
      const terminal = focusedTerminal();
      const target = terminal ?? main();
      if (!target) return;
      const factor = nextZoomFactor(target.webContents.getZoomFactor(), action);
      target.webContents.setZoomFactor(factor);
      if (!terminal) target.webContents.send("app:zoom-changed", { factor });
    },

    reload(): void {
      (focusedTerminal() ?? main())?.webContents.reload();
    },
  };
}
