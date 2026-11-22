// Wires the shortcut service into the app (specs/653): loads the overrides,
// tells the main and Terminal windows when they change, and makes sure a
// recorder in the main window cannot leave menu shortcuts paused.
import type { LocalStore } from "../persistence/local-store";
import { SHORTCUT_EVENTS, type ShortcutSnapshot } from "../../shared/shortcuts-ipc";
import { createShortcutService, type RecordingTarget, type ShortcutService } from "./shortcut-service";

export interface ShortcutWindow {
  isDestroyed(): boolean;
  on(event: "blur", listener: () => void): unknown;
  webContents: RecordingTarget & {
    send(channel: string, payload: unknown): void;
    on(event: "did-start-navigation", listener: () => void): unknown;
  };
}

type WindowCreatedListener = (event: unknown, win: ShortcutWindow) => void;

export interface ShortcutAppEvents {
  on(event: "browser-window-created", listener: WindowCreatedListener): unknown;
  removeListener(event: "browser-window-created", listener: WindowCreatedListener): unknown;
}

export async function installShortcuts(deps: {
  app: ShortcutAppEvents;
  store: Pick<LocalStore, "get" | "set">;
  platform: NodeJS.Platform;
  mainWindow(): ShortcutWindow | null;
  terminalWindow(): ShortcutWindow | null;
}): Promise<{ service: ShortcutService; dispose(): void }> {
  const service = createShortcutService({ store: deps.store, platform: deps.platform });
  await service.load();

  function send(win: ShortcutWindow | null, snapshot: ShortcutSnapshot): void {
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    try {
      win.webContents.send("shortcuts:changed", snapshot);
    } catch (error: unknown) {
      console.warn("[shortcuts] could not notify a window:", error instanceof Error ? error.message : String(error));
    }
  }

  const unsubscribe = service.onChange((snapshot) => {
    const parsed = SHORTCUT_EVENTS["shortcuts:changed"].safeParse(snapshot);
    if (!parsed.success) {
      console.warn("[ipc] refusing to send invalid event on shortcuts:changed");
      return;
    }
    send(deps.mainWindow(), parsed.data);
    send(deps.terminalWindow(), parsed.data);
  });

  // Only the main window may record (sender policy). It is checked when the
  // event fires because the window is created before it becomes the main one.
  const watchWindow: WindowCreatedListener = (_event, win) => {
    const stopRecording = () => {
      if (deps.mainWindow() === win) service.setRecording(win.webContents, false);
    };
    win.on("blur", stopRecording);
    win.webContents.on("did-start-navigation", stopRecording);
  };
  deps.app.on("browser-window-created", watchWindow);

  return {
    service,
    dispose() {
      deps.app.removeListener("browser-window-created", watchWindow);
      unsubscribe();
      service.dispose();
    },
  };
}
