import { app, BrowserWindow, ipcMain, Notification, safeStorage, session, shell } from "electron";
import { join } from "node:path";
import { AuthService } from "./auth/auth-service";
import { createCredentialStore } from "./auth/credential-store";
import { installHeaderInjection } from "./auth/header-injection";
import { EmbedService } from "./embeds/embed-service";
import { registerIpcHandlers } from "./ipc/handlers";
import { createLocalStore } from "./persistence/local-store";
import { installAppMenu } from "./platform/menu";
import { EVENT_CHANNELS, type EventChannel, type EventPayload } from "../shared/ipc-contract";

const DEFAULT_PLATFORM_HOST = "https://app.matrix-os.com";

// Test isolation: e2e runs point userData at a temp dir so they never touch
// the real profile or credential.
if (process.env.OPERATOR_USER_DATA_DIR) {
  app.setPath("userData", process.env.OPERATOR_USER_DATA_DIR);
}

// Single instance: second launches focus the existing window (FR-092).
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

let mainWindow: BrowserWindow | null = null;

function sendEvent<C extends EventChannel>(channel: C, payload: EventPayload<C>): void {
  const parsed = EVENT_CHANNELS[channel].safeParse(payload);
  if (!parsed.success) {
    console.warn(`[ipc] refusing to send invalid event on ${channel}`);
    return;
  }
  mainWindow?.webContents.send(channel, parsed.data);
}

async function openExternalHttps(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol !== "https:") return;
  await shell.openExternal(parsed.toString());
}

function createWindow(bounds: { x?: number; y?: number; width: number; height: number }): BrowserWindow {
  const win = new BrowserWindow({
    ...bounds,
    minWidth: 880,
    minHeight: 560,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 13 },
    backgroundColor: "#0e0e13",
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  win.once("ready-to-show", () => win.show());

  // window.open / target=_blank from the renderer → system browser only.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalHttps(url);
    return { action: "deny" };
  });

  win.on("focus", () => sendEvent("window:focus-changed", { focused: true }));
  win.on("blur", () => sendEvent("window:focus-changed", { focused: false }));

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"));
  }
  return win;
}

app.whenReady().then(async () => {
  const userData = app.getPath("userData");
  const store = createLocalStore({ dir: userData });
  const credentialStore = createCredentialStore({ dir: userData, safeStorage });

  const platformHost = process.env.OPERATOR_GATEWAY_URL ?? DEFAULT_PLATFORM_HOST;

  const auth = new AuthService({
    credentialStore,
    platformHost,
    openExternal: openExternalHttps,
    loadProfile: () => store.get("profile"),
    saveProfile: (profile) => store.set("profile", profile),
    clearProfile: () => store.delete("profile"),
    onAuthChanged: (status) => {
      sendEvent("auth:changed", {
        signedIn: status.signedIn,
        ...(status.handle ? { handle: status.handle } : {}),
      });
    },
  });
  await auth.init();

  // Renderer session gets origin-scoped bearer injection; embed partitions
  // (separate sessions) never do (lesson L1).
  installHeaderInjection(
    session.defaultSession,
    () => auth.getToken(),
    () => auth.getGatewayOrigin(),
  );

  const embeds = new EmbedService({
    getWindow: () => mainWindow,
    getGatewayOrigin: () => auth.getGatewayOrigin(),
    getToken: () => auth.getToken(),
    emitState: (embedId, state) => sendEvent("embed:state", { embedId, state }),
  });

  registerIpcHandlers(ipcMain, {
    auth,
    store,
    embeds,
    openExternal: openExternalHttps,
    setBadgeCount: (count) => {
      app.setBadgeCount(count);
    },
    notify: ({ threadId, title, body }) => {
      if (!Notification.isSupported()) return;
      const notification = new Notification({ title, body, silent: false });
      notification.on("click", () => {
        mainWindow?.show();
        mainWindow?.focus();
        sendEvent("notification:clicked", { threadId });
      });
      notification.show();
    },
    onRuntimeChanged: (slot) => {
      // Switching runtime invalidates embed cookies/tokens; tear them down so
      // they re-handshake against the new slot (Integration Wiring rule).
      embeds.closeAll();
      sendEvent("runtime:changed", { slot });
    },
  });

  const savedBounds = await store.get("windowBounds");
  mainWindow = createWindow(savedBounds ?? { width: 1280, height: 820 });
  installAppMenu(() => mainWindow);

  let boundsSaveTimer: ReturnType<typeof setTimeout> | null = null;
  const persistBounds = () => {
    if (boundsSaveTimer) clearTimeout(boundsSaveTimer);
    boundsSaveTimer = setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const b = mainWindow.getBounds();
      void store
        .set("windowBounds", { x: b.x, y: b.y, width: b.width, height: b.height })
        .catch((err: unknown) => {
          console.warn(
            "[main] failed to persist window bounds:",
            err instanceof Error ? err.message : String(err),
          );
        });
    }, 500);
  };
  mainWindow.on("resize", persistBounds);
  mainWindow.on("move", persistBounds);
  mainWindow.on("closed", () => {
    if (boundsSaveTimer) clearTimeout(boundsSaveTimer);
    mainWindow = null;
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow({ width: 1280, height: 820 });
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
