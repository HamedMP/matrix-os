// Wires the shortcut service into the app (specs/653): loads the overrides,
// tells the main and Terminal windows when they change, runs bound keys from
// every web contents, makes sure a recorder in the main window cannot leave
// menu shortcuts paused, and ends a window's Terminal key claims when it blurs,
// navigates or goes away.
import type { ShortcutActionId } from "@matrix-os/contracts/keyboard-shortcuts";
import type { LocalStore } from "../persistence/local-store";
import { SHORTCUT_EVENTS, type ShortcutSnapshot } from "../../shared/shortcuts-ipc";
import { createShortcutInputMatcher, type ShortcutInput } from "./input-matcher";
import { isShortcutActionAvailable } from "./shortcut-availability";
import { terminalWindowBindings } from "../platform/terminal-menu-items";
import { createShortcutService, toShortcutPlatform, type RecordingTarget, type ShortcutService } from "./shortcut-service";

// Windows plus embedded app views; past this, new ones go without shortcuts.
const MAX_WATCHED = 512;

interface NavigationDetails {
  isMainFrame: boolean;
  isSameDocument: boolean;
}
type InputListener = (event: { preventDefault(): void }, input: ShortcutInput) => void;
type NavigationListener = (details: NavigationDetails) => void;

export interface ShortcutContents {
  getType(): string;
  on(event: "before-input-event", listener: InputListener): unknown;
  on(event: "destroyed", listener: () => void): unknown;
  removeListener(event: "before-input-event", listener: InputListener): unknown;
  removeListener(event: "destroyed", listener: () => void): unknown;
}

export interface ShortcutWindow {
  isDestroyed(): boolean;
  on(event: "blur" | "closed", listener: () => void): unknown;
  removeListener(event: "blur" | "closed", listener: () => void): unknown;
  webContents: RecordingTarget & {
    send(channel: string, payload: unknown): void;
    on(event: "did-start-navigation", listener: NavigationListener): unknown;
    removeListener(event: "did-start-navigation", listener: NavigationListener): unknown;
  };
}

type WindowCreatedListener = (event: unknown, win: ShortcutWindow) => void;
type ContentsCreatedListener = (event: unknown, contents: ShortcutContents) => void;

export interface ShortcutAppEvents {
  on(event: "browser-window-created", listener: WindowCreatedListener): unknown;
  on(event: "web-contents-created", listener: ContentsCreatedListener): unknown;
  removeListener(event: "browser-window-created", listener: WindowCreatedListener): unknown;
  removeListener(event: "web-contents-created", listener: ContentsCreatedListener): unknown;
}

export async function installShortcuts(deps: {
  app: ShortcutAppEvents;
  store: Pick<LocalStore, "get" | "set">;
  platform: NodeJS.Platform;
  mainWindow(): ShortcutWindow | null;
  terminalWindow(): ShortcutWindow | null;
  /** Runs an action; the application menu's items call the same runner. */
  run(id: ShortcutActionId): void;
}): Promise<{ service: ShortcutService; dispose(): void }> {
  const service = createShortcutService({ store: deps.store, platform: deps.platform });
  await service.load();
  let effective = service.snapshot().effective;
  // Each watched window or web contents maps to the function that detaches it.
  const detachers = new Map<object, () => void>();

  function watch(target: object, detach: () => void): boolean {
    if (detachers.size >= MAX_WATCHED) {
      console.warn("[shortcuts] too many windows; shortcuts are off in a new one");
      return false;
    }
    detachers.set(target, () => {
      detachers.delete(target);
      detach();
    });
    return true;
  }

  function send(win: ShortcutWindow | null, snapshot: ShortcutSnapshot): void {
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    try {
      win.webContents.send("shortcuts:changed", snapshot);
    } catch (error: unknown) {
      console.warn("[shortcuts] could not notify a window:", error instanceof Error ? error.message : String(error));
    }
  }

  const unsubscribe = service.onChange((snapshot) => {
    effective = snapshot.effective;
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
    const contents = win.webContents;
    // A Terminal's claim lasts only while its window has focus.
    const onBlur = () => {
      service.clearTerminalClaims(contents);
      if (deps.mainWindow() === win) service.setRecording(contents, false);
    };
    // Subframe loads and in-page navigations leave the recorder on screen.
    const onNavigation: NavigationListener = (details) => {
      if (details.isMainFrame && !details.isSameDocument) onBlur();
    };
    // Electron throws on any use of a window after "closed", and its listeners
    // die with it, so a closed window is only forgotten, never detached. The
    // claims map uses `contents` only as a key, so clearing it is safe.
    const onClosed = () => {
      detachers.delete(win);
      service.clearTerminalClaims(contents);
    };
    const attached = watch(win, () => {
      win.removeListener("blur", onBlur);
      win.removeListener("closed", onClosed);
      contents.removeListener("did-start-navigation", onNavigation);
    });
    if (!attached) return;
    win.on("blur", onBlur);
    win.on("closed", onClosed);
    contents.on("did-start-navigation", onNavigation);
  };

  const terminalKeys = terminalWindowBindings(deps.platform === "darwin");
  // Covers the main window, the Terminal window and every embedded app view.
  const matcher = createShortcutInputMatcher({
    effective: () => effective,
    platform: toShortcutPlatform(deps.platform),
    isRecording: () => service.isRecording(),
    isAvailable: (id) => isShortcutActionAvailable(id, deps.platform),
    // The Terminal window keeps the keys of its own menu (spec 2706), as a Terminal keeps its profile's.
    isClaimed: (source, binding) => service.isTerminalClaimed(source, binding)
      || (deps.terminalWindow()?.webContents === source && terminalKeys.has(binding)),
    run: deps.run,
  });
  const watchContents: ContentsCreatedListener = (_event, contents) => {
    // DevTools keeps its own keys.
    if (contents.getType() === "devtools") return;
    const onInput: InputListener = (event, input) => matcher(event, input, contents);
    // Destroyed web contents are forgotten the same way as closed windows.
    const onDestroyed = () => {
      detachers.delete(contents);
      service.clearTerminalClaims(contents);
    };
    const attached = watch(contents, () => {
      contents.removeListener("before-input-event", onInput);
      contents.removeListener("destroyed", onDestroyed);
    });
    if (!attached) return;
    contents.on("before-input-event", onInput);
    contents.on("destroyed", onDestroyed);
  };

  deps.app.on("browser-window-created", watchWindow);
  deps.app.on("web-contents-created", watchContents);

  return {
    service,
    dispose() {
      deps.app.removeListener("browser-window-created", watchWindow);
      deps.app.removeListener("web-contents-created", watchContents);
      for (const detach of [...detachers.values()]) detach();
      unsubscribe();
      service.dispose();
    },
  };
}
