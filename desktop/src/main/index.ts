import { app, BrowserWindow, ipcMain, Notification, safeStorage, screen, session, shell } from "electron";
import { join } from "node:path";
import { AuthService } from "./auth/auth-service";
import { createCredentialStore } from "./auth/credential-store";
import { installGatewayCors, installHeaderInjection } from "./auth/header-injection";
import { EmbedService } from "./embeds/embed-service";
import { NativeAppBridge, createNativeAppQueryRequester } from "./embeds/native-app-bridge";
import {
  abortCodingAgentThread,
  createCodingAgentSourcePullRequest,
  createCodingAgentThread,
  createCodingAgentTurn,
  fetchCodingAgentFileBrowse,
  fetchCodingAgentFileContent,
  fetchCodingAgentFileSearch,
  fetchCodingAgentNotificationPreferences,
  fetchCodingAgentProjectWorkspace,
  fetchCodingAgentThreadSnapshot,
  fetchCodingAgentReviewSnapshot,
  fetchCodingAgentReviewSummaries,
  fetchCodingAgentRuntimeSummary,
  prepareCodingAgentSourceCommit,
  saveCodingAgentFileContent,
  submitCodingAgentApprovalDecision,
  submitCodingAgentInputAnswer,
  updateCodingAgentNotificationPreferences,
} from "./coding-agents/runtime-summary-client";
import { createCodingAgentThreadEventStreamer } from "./coding-agents/thread-event-stream";
import {
  fetchHermesConfiguration,
  fetchHermesEnvironment,
  removeHermesCredential,
  setHermesCredential,
  updateHermesConfiguration,
} from "./hermes/configuration-client";
import { registerIpcHandlers } from "./ipc/handlers";
import { createLocalStore } from "./persistence/local-store";
import { installAppMenu } from "./platform/menu";
import {
  fitWindowBoundsToWorkArea,
  type FittedWindowBounds,
  type WindowBounds,
} from "./platform/window-bounds";
import { createUpdater } from "./updates";
import { createUpdateAwareBeforeQuit } from "./update-quit";
import { safeExternalHttpUrl } from "./external-url";
import { EVENT_CHANNELS, type EventChannel, type EventPayload } from "../shared/ipc-contract";

const DEFAULT_PLATFORM_HOST = "https://app.matrix-os.com";
const DESKTOP_APP_NAME = "Matrix OS";

app.setName(DESKTOP_APP_NAME);

// Test isolation: e2e runs point userData at a temp dir so they never touch
// the real profile or credential.
if (process.env.OPERATOR_USER_DATA_DIR) {
  app.setPath("userData", process.env.OPERATOR_USER_DATA_DIR);
}

let mainWindow: BrowserWindow | null = null;
let updateCheckTimer: ReturnType<typeof setInterval> | null = null;
let closeCodingAgentThreadEvents: (() => void) | null = null;
let handleUpdateBeforeQuit: ((event: { preventDefault(): void }) => void) | null = null;

function isMatrixOsDeepLink(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "matrixos:" || url.protocol === "matrix-os:";
  } catch {
    return false;
  }
}

function focusMainWindow(): void {
  const win = mainWindow ?? BrowserWindow.getAllWindows()[0];
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function handleDeepLink(url: string): void {
  if (!isMatrixOsDeepLink(url)) return;
  focusMainWindow();
}

function sendEvent<C extends EventChannel>(channel: C, payload: EventPayload<C>): void {
  const parsed = EVENT_CHANNELS[channel].safeParse(payload);
  if (!parsed.success) {
    console.warn(`[ipc] refusing to send invalid event on ${channel}`);
    return;
  }
  mainWindow?.webContents.send(channel, parsed.data);
}

async function openExternalHttpUrl(url: string): Promise<void> {
  const externalUrl = safeExternalHttpUrl(url);
  if (!externalUrl) return;
  await shell.openExternal(externalUrl);
}

function createWindow(bounds: FittedWindowBounds): BrowserWindow {
  const win = new BrowserWindow({
    ...bounds,
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

  // window.open / target=_blank from the renderer goes to the system browser only.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalHttpUrl(url).catch((err: unknown) => {
      logMainError("failed to open external URL", err);
    });
    return { action: "deny" };
  });

  win.on("focus", () => sendEvent("window:focus-changed", { focused: true }));
  win.on("blur", () => sendEvent("window:focus-changed", { focused: false }));

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL).catch((err: unknown) => {
      logMainError("failed to load renderer URL", err);
    });
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html")).catch((err: unknown) => {
      logMainError("failed to load renderer file", err);
    });
  }
  return win;
}

function logMainError(label: string, err: unknown): void {
  console.warn(`[main] ${label}:`, err instanceof Error ? err.message : String(err));
}

// Single instance: second launches focus the existing window (FR-092).
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const deepLink = argv.find(isMatrixOsDeepLink);
    if (deepLink) {
      handleDeepLink(deepLink);
      return;
    }
    focusMainWindow();
  });

  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });

  void app
    .whenReady()
    .then(async () => {
      // Packaged builds get the icon from build/icon.icns automatically; in dev
      // the dock shows Electron's default icon unless we set the brand icon.
      if (process.platform === "darwin" && !app.isPackaged && app.dock) {
        try {
          app.dock.setIcon(join(app.getAppPath(), "build", "icon.png"));
        } catch (err: unknown) {
          console.warn(
            "[main] could not set dev dock icon:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      const userData = app.getPath("userData");
      const store = createLocalStore({ dir: userData });
      const credentialStore = createCredentialStore({ dir: userData, safeStorage });

      const platformHost = process.env.OPERATOR_GATEWAY_URL ?? DEFAULT_PLATFORM_HOST;
      const runtimeSelectionOrigin = process.env.MATRIX_API_ORIGIN
        ?? (platformHost === DEFAULT_PLATFORM_HOST ? "https://api.matrix-os.com" : platformHost);

      const auth = new AuthService({
        credentialStore,
        platformHost,
        runtimeSelectionOrigin,
        loadProfile: () => store.get("profile"),
        saveProfile: (profile) => store.set("profile", profile),
        clearProfile: () => store.delete("profile"),
        onAuthChanged: (status) => {
          sendEvent("auth:changed", {
            signedIn: status.signedIn,
            ...(status.handle ? { handle: status.handle } : {}),
            ...(status.displayName ? { displayName: status.displayName } : {}),
            ...(status.imageUrl ? { imageUrl: status.imageUrl } : {}),
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
      // The renderer is a different origin than the gateway (file:// in prod,
      // localhost in dev), so allow its cross-origin fetches to the gateway.
      const rendererOrigin = process.env.ELECTRON_RENDERER_URL
        ? new URL(process.env.ELECTRON_RENDERER_URL).origin
        : "null";
      installGatewayCors(session.defaultSession, () => auth.getGatewayOrigin(), rendererOrigin);

      const nativeAppBridge = new NativeAppBridge({
        gatewayOrigin: () => auth.getGatewayOrigin(),
        request: createNativeAppQueryRequester({
          getGatewayOrigin: () => auth.getGatewayOrigin(),
          getToken: () => auth.getToken(),
        }),
      });
      nativeAppBridge.registerIpc(ipcMain);

      const embeds = new EmbedService({
        getWindow: () => mainWindow,
        getGatewayOrigin: () => auth.getGatewayOrigin(),
        getToken: () => auth.getToken(),
        emitState: (embedId, state) => sendEvent("embed:state", { embedId, state }),
        appBridge: nativeAppBridge,
        appPreloadPath: join(__dirname, "../preload/app-bridge.cjs"),
      });
      const updater = createUpdater({
        onAvailable: (version) => {
          console.info(`[updates] downloading Matrix OS ${version}`);
        },
        onStateChanged: (snapshot) => {
          sendEvent("update:state-changed", snapshot);
        },
        onReleaseReady: (release) => store.set("desktopUpdateRelease", {
          ...release,
          shown: false,
        }),
        onReady: (version) => {
          if (!Notification.isSupported()) return;
          new Notification({
            title: "Matrix OS update ready",
            body: `Use Update in the sidebar to restart and install version ${version}.`,
            silent: false,
          }).show();
        },
      });
      handleUpdateBeforeQuit = createUpdateAwareBeforeQuit({
        status: () => updater.status(),
        isInstallStarted: () => updater.isInstallStarted(),
        install: () => updater.install(),
        quit: () => app.quit(),
        reportError: (error) => {
          console.warn(
            "[updates] could not install ready update while quitting:",
            error instanceof Error ? error.message : String(error),
          );
        },
      });
      const codingAgentThreadEvents = createCodingAgentThreadEventStreamer({
        auth,
        emit: sendEvent,
      });
      closeCodingAgentThreadEvents = () => codingAgentThreadEvents.closeAll();

      registerIpcHandlers(ipcMain, {
        auth,
        store,
        embeds,
        openExternal: openExternalHttpUrl,
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
          codingAgentThreadEvents.closeAll();
          sendEvent("runtime:changed", { slot });
        },
        checkUpdate: async () => {
          await updater.check();
          return updater.snapshot();
        },
        getUpdateSnapshot: () => updater.snapshot(),
        installUpdate: () => updater.install(),
        getWhatsNew: async () => {
          const stored = await store.get("desktopUpdateRelease");
          if (!stored || stored.version !== app.getVersion()) {
            return { release: null, shouldOpen: false };
          }
          const { shown, ...release } = stored;
          return { release, shouldOpen: !shown };
        },
        acknowledgeWhatsNew: async (version) => {
          if (version !== app.getVersion()) return;
          await store.acknowledgeDesktopUpdateRelease(version);
        },
        fetchRuntimeSummary: () => fetchCodingAgentRuntimeSummary(auth),
        fetchProjectWorkspace: (request) => fetchCodingAgentProjectWorkspace(auth, request),
        fetchNotificationPreferences: () => fetchCodingAgentNotificationPreferences(auth),
        updateNotificationPreferences: (request) => updateCodingAgentNotificationPreferences(auth, request),
        fetchHermesConfiguration: () => fetchHermesConfiguration(auth),
        fetchHermesEnvironment: () => fetchHermesEnvironment(auth),
        updateHermesConfiguration: (request) => updateHermesConfiguration(auth, request),
        setHermesCredential: (request) => setHermesCredential(auth, request),
        removeHermesCredential: (request) => removeHermesCredential(auth, request),
        fetchReviewSummaries: (options) => fetchCodingAgentReviewSummaries(auth, options),
        fetchReviewSnapshot: (options) => fetchCodingAgentReviewSnapshot(auth, options),
        fetchFileBrowse: (request) => fetchCodingAgentFileBrowse(auth, request),
        fetchFileSearch: (request) => fetchCodingAgentFileSearch(auth, request),
        fetchFileContent: (request) => fetchCodingAgentFileContent(auth, request),
        saveFileContent: (request) => saveCodingAgentFileContent(auth, request),
        prepareSourceCommit: (request) => prepareCodingAgentSourceCommit(auth, request),
        createSourcePullRequest: (request) => createCodingAgentSourcePullRequest(auth, request),
        fetchThreadSnapshot: (options) => fetchCodingAgentThreadSnapshot(auth, options),
        subscribeThreadEvents: (request) => codingAgentThreadEvents.subscribe(request),
        unsubscribeThreadEvents: ({ threadId }) => codingAgentThreadEvents.unsubscribe(threadId),
        submitApprovalDecision: ({ threadId, approvalId, decision, clientRequestId, correlationId }) =>
          submitCodingAgentApprovalDecision(auth, {
            threadId,
            approvalId,
            request: { decision, clientRequestId, correlationId },
          }),
        submitInputAnswer: ({ threadId, inputRequestId, answer, structuredAnswers, clientRequestId, correlationId }) =>
          submitCodingAgentInputAnswer(auth, {
            threadId,
            inputRequestId,
            request: { answer, ...(structuredAnswers ? { structuredAnswers } : {}), clientRequestId, correlationId },
          }),
        createAgentThread: (request) => createCodingAgentThread(auth, request),
        createAgentTurn: (request) => createCodingAgentTurn(auth, request),
        abortAgentThread: (request) => abortCodingAgentThread(auth, request),
      });

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
      const openMainWindow = async () => {
        const savedBounds = await store.get("windowBounds");
        const requestedBounds: WindowBounds = savedBounds ?? { width: 1280, height: 820 };
        const display = screen.getDisplayMatching({
          x: requestedBounds.x ?? 0,
          y: requestedBounds.y ?? 0,
          width: requestedBounds.width,
          height: requestedBounds.height,
        });
        mainWindow = createWindow(fitWindowBoundsToWorkArea(requestedBounds, display.workArea));
        mainWindow.on("resize", persistBounds);
        mainWindow.on("move", persistBounds);
        mainWindow.on("closed", () => {
          if (boundsSaveTimer) clearTimeout(boundsSaveTimer);
          embeds.closeAll();
          codingAgentThreadEvents.closeAll();
          mainWindow = null;
        });
      };

      await openMainWindow();
      installAppMenu(
        () => mainWindow,
        () => {
          focusMainWindow();
          void updater.check();
        },
      );

      void updater.check();
      updateCheckTimer = setInterval(() => {
        void updater.check();
      }, 60 * 60 * 1000);

      app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          void openMainWindow();
        }
      });
    })
    .catch((err: unknown) => {
      logMainError("failed to start app", err);
    });

  app.on("before-quit", (event) => {
    if (updateCheckTimer) {
      clearInterval(updateCheckTimer);
      updateCheckTimer = null;
    }
    closeCodingAgentThreadEvents?.();
    closeCodingAgentThreadEvents = null;
    handleUpdateBeforeQuit?.(event);
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
