import { claimPreviewProfile } from "./preview-pair-profile-lease";
import { createPreviewStartupAcknowledgement } from "./preview-pair-startup-ack";
import { acknowledgeReopenedPreview } from "./preview-pair-reopen";
import { createPreviewWindowReopener } from "./preview-pair-window";
import { initializeDesktopPreview } from "./preview-pair-startup";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Notification, safeStorage, screen, session, shell, webContents, type IpcMainInvokeEvent } from "electron";
import { join, dirname } from "node:path";
import { createFileDownloadService } from "./files/file-download-service";
import { createOrganizationDriveTransferService } from "./files/organization-drive-transfer";
import { readDriveUploadFile, saveDriveDownloadFile } from "./files/organization-drive-file-io";
import { registerTerminalClipboardIpc } from "./files/terminal-clipboard";
import { pathToFileURL } from "node:url";
import { createNativeChatgptPlanService } from "./chatgpt-plan/service";
import { fetchNativePlan } from "./chatgpt-plan/transport";
import { createPlanVault } from "./chatgpt-plan/vault";
import { createPlanDiagnosticStore, planDiagnosticDirectory } from "./chatgpt-plan/diagnostic-store";
import { createNavigationCache } from "./persistence/navigation-cache";
import { registerNavigationCacheIpc } from "./ipc/navigation-cache";
import { registerChatgptPlanIpc } from "./ipc/chatgpt-plan";
import { AuthService } from "./auth/auth-service";
import { createAnalyticsBeforeQuit } from "./analytics-quit";
import { readDesktopBuildSource } from "./build-source";
import { createCredentialStore } from "./auth/credential-store";
import {
  installGatewayCors,
  installHeaderInjection,
  installSupportMessageAnalytics,
} from "./auth/header-injection";
import { EmbedService } from "./embeds/embed-service";
import {
  NativeAppBridge,
  createNativeAppQueryRequester,
  createNativeAppGatewayRequester,
  createNativeAppAiRequester,
} from "./embeds/native-app-bridge";
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
import { createNativeChatImportService } from "./files/local-chat-import";
import { discoverLocalChats } from "./files/local-chat-discovery";
import { registerLocalChatImportIpc } from "./ipc/local-chat-import";
import { registerIpcHandlers } from "./ipc/handlers";
import { fetchDesktopSupportIdentity } from "./support/support-identity-client";
import { createLocalStore } from "./persistence/local-store";
import { installAppMenu } from "./platform/menu";
import { registerWindowsProtocolClients } from "./platform/protocol-registration";
import { installMainRendererMediaPermissions } from "./media-permissions";
import {
  fitWindowBoundsToWorkArea,
  type FittedWindowBounds,
  type WindowBounds,
} from "./platform/window-bounds";
import { windowChromeOptions } from "./platform/window-chrome";
import { createUpdater } from "./updates";
import { createUpdateAwareBeforeQuit } from "./update-quit";
import { safeExternalHttpUrl, safeChatgptAuthorizationUrl } from "./external-url";
import { desktopDevHostResolverRules, resolveDesktopRendererUrl } from "./renderer-url";
import { EVENT_CHANNELS, type EventChannel, type EventPayload } from "../shared/ipc-contract";
import { createNativeAppCapabilityRequester, createNativeAppAiRoutesRequester } from "./embeds/native-app-capabilities";
import { createNativeAppOpenResolver } from "./embeds/native-app-open";
import { installBrowserProductSessionCookie } from "./embeds/browser-product-session";
import { createNativeAppChatNavigationBroker, registerNativeAppChatCompletionIpc } from "./embeds/native-app-chat-navigation";
import { configureDesktopIdentity } from "./desktop-identity";
import { createSenderPolicy, senderRole } from "./ipc/sender-policy";
import { createTerminalWindowController } from "./terminal-window/controller";
import { createTerminalBrowserWindow } from "./terminal-window/window";
import { createComputerCredentialBroker } from "./terminal-window/credential-broker";
import { installTerminalWindowAuth } from "./terminal-window/gateway-auth";
import { createLocalTerminalHost, type LocalTerminalHost } from "./local-terminals/host";
import { registerLocalTerminalIpc } from "./local-terminals/ipc";
import { localLoginShell, resolveLocalTerminalRuntime, startLocalTerminalCore } from "./local-terminals/runtime";
import { LOCAL_TERMINAL_VERSION } from "../shared/local-terminals";
import { connect as connectSocket } from "node:net";
import { homedir, userInfo } from "node:os";
import {
  TERMINAL_WINDOW_EVENT_CHANNELS,
  TERMINAL_WINDOW_PARTITION,
  TERMINAL_WINDOW_QUERY_KEY,
  TERMINAL_WINDOW_QUERY_VALUE,
  terminalWindowUrl,
} from "../shared/terminal-window";

const DEFAULT_PLATFORM_HOST = "https://app.matrix-os.com";
const desktopRendererUrl = resolveDesktopRendererUrl(process.env.ELECTRON_RENDERER_URL);

configureDesktopIdentity(app, {
  qaIdentity: process.env.MATRIX_DESKTOP_QA_IDENTITY,
  userDataDir: process.env.OPERATOR_USER_DATA_DIR,
});
if (desktopRendererUrl && desktopRendererUrl !== process.env.ELECTRON_RENDERER_URL) {
  app.commandLine.appendSwitch("host-resolver-rules", desktopDevHostResolverRules());
}

// ESM top-level await is required: sessionData and the singleton lock must be
// selected before Electron emits ready. Normal startup does not add an await.
const previewContext = process.env.MATRIX_PREVIEW_PAIR_CONTEXT === undefined ? null
  : await initializeDesktopPreview(app, process.env, { buildSource: readDesktopBuildSource() }).catch((error: unknown) => {
    console.warn("[preview-pair] startup unavailable", error instanceof Error ? error.name : "UnknownError");
    app.exit(1);
    throw new Error("Preview startup is unavailable");
  });

const bindPreviewStartupAcknowledgement = createPreviewStartupAcknowledgement(previewContext,
  process.env.MATRIX_PREVIEW_PAIR_READY_PORT, (error: unknown) => {
    logMainError("preview launcher acknowledgement failed", error); app.quit();
  });

let mainWindow: BrowserWindow | null = null;
let terminalWindows: ReturnType<typeof createTerminalWindowController<BrowserWindow>> | null = null;
const terminalWindowEvents = new Set<string>(TERMINAL_WINDOW_EVENT_CHANNELS);
let computerCredentials: { clear(): void } | null = null;
let localTerminals: LocalTerminalHost | null = null;
let reopenPreviewWindow: (() => Promise<void>) | undefined;
let navigationCache: ReturnType<typeof createNavigationCache> | null = null;
let chatgptPlan: ReturnType<typeof createNativeChatgptPlanService> | null = null;
let navigationCacheDrained = false;
let drainingNavigationCache = false;
let planDiagnostics: ReturnType<typeof createPlanDiagnosticStore> | null = null;
let planDiagnosticsDrained = false;
let drainingPlanDiagnostics = false;
let planDrained = false;
let drainingPlan = false;
let updateCheckTimer: ReturnType<typeof setInterval> | null = null;
let fileDownloads: ReturnType<typeof createFileDownloadService> | null = null;
let localChatImports:ReturnType<typeof createNativeChatImportService>|null=null;
let nativeAppChatNavigation: ReturnType<typeof createNativeAppChatNavigationBroker> | null = null;
let importsDrained=false;
let drainingImports=false;
let organizationDriveTransfers: ReturnType<typeof createOrganizationDriveTransferService> | null = null;
let downloadsDrained = false;
let drainingDownloads = false;
let closeCodingAgentThreadEvents: (() => void) | null = null;
let handleUpdateBeforeQuit: ((event: { preventDefault(): void }) => void) | null = null;
let handleAnalyticsBeforeQuit: ((event: { preventDefault(): void }) => boolean) | null = null;
let completePendingAnalyticsFlush: (() => void) | null = null;

function isMatrixOsDeepLink(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "matrixos:" || url.protocol === "matrix-os:";
  } catch (error: unknown) {
    if (error instanceof TypeError) return false;
    throw error;
  }
}

function focusMainWindow(): void {
  // Never fall back to "any window": the Terminal window is not the main one.
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
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
  // A session change reaches the Terminal window too, and voids every
  // per-computer credential held for it.
  if (channel === "auth:changed") {
    computerCredentials?.clear();
    sendTerminalWindowEvent(channel, payload);
  }
}

/** Events are addressed to a named window; the Terminal window gets only its allowlist. */
function sendTerminalWindowEvent<C extends EventChannel>(channel: C, payload: EventPayload<C>): void {
  if (!terminalWindowEvents.has(channel)) return;
  const win = terminalWindows?.current();
  if (!win || win.webContents.isDestroyed()) return;
  const parsed = EVENT_CHANNELS[channel].safeParse(payload);
  if (!parsed.success) {
    console.warn(`[ipc] refusing to send invalid event on ${channel}`);
    return;
  }
  win.webContents.send(channel, parsed.data);
}

async function openExternalHttpUrl(url: string): Promise<void> {
  const externalUrl = safeExternalHttpUrl(url);
  if (!externalUrl) return;
  await shell.openExternal(externalUrl);
}

function createWindow(bounds: FittedWindowBounds): BrowserWindow {
  const packagedRendererPath = join(__dirname, "../renderer/index.html");
  const trustedRendererUrl = desktopRendererUrl ?? pathToFileURL(packagedRendererPath).toString();
  const win = new BrowserWindow({
    ...bounds,
    ...windowChromeOptions(process.platform),
    backgroundColor: "#0e0e13",
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  installMainRendererMediaPermissions(win.webContents.session, win.webContents, trustedRendererUrl);

  win.once("ready-to-show", () => win.show());
  bindPreviewStartupAcknowledgement(win.webContents);

  // window.open / target=_blank from the renderer goes to the system browser only.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalHttpUrl(url).catch((err: unknown) => {
      logMainError("failed to open external URL", err);
    });
    return { action: "deny" };
  });

  win.on("focus", () => sendEvent("window:focus-changed", { focused: true }));
  win.on("blur", () => sendEvent("window:focus-changed", { focused: false }));

  if (desktopRendererUrl) {
    void win.loadURL(desktopRendererUrl).catch((err: unknown) => {
      logMainError("failed to load renderer URL", err);
    });
  } else {
    void win.loadFile(packagedRendererPath).catch((err: unknown) => {
      logMainError("failed to load renderer file", err);
    });
  }
  return win;
}

function logMainError(label: string, err: unknown): void {
  console.warn(`[main] ${label}:`, err instanceof Error ? err.message : String(err));
}

// Single instance: second launches focus the existing window (FR-092).
const gotLock = app.requestSingleInstanceLock(previewContext ? {
  previewPair: { proof: process.env.MATRIX_PREVIEW_PAIR_CONTEXT, port: process.env.MATRIX_PREVIEW_PAIR_READY_PORT },
} : undefined);
const previewLease = previewContext && gotLock ? await claimPreviewProfile(dirname(app.getPath("userData"))).catch((error: unknown) => {
  logMainError("preview profile unavailable", error); app.exit(1); throw new Error("Preview profile is unavailable");
}) : null;
if (previewLease) app.once("will-quit", () => { void previewLease.release().catch((error: unknown) => logMainError("preview profile release failed", error)); });
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv, _workingDirectory, additionalData) => {
    if (previewContext) {
      void acknowledgeReopenedPreview(previewContext,
        additionalData && typeof additionalData === "object" && "previewPair" in additionalData ? additionalData.previewPair : null,
        readDesktopBuildSource(), async () => {
          if (!reopenPreviewWindow) throw new Error("Preview window is unavailable");
          await reopenPreviewWindow();
        }).catch((error: unknown) => logMainError("preview reopen refused", error));
      return;
    }
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
      const failedProtocolRegistrations = registerWindowsProtocolClients(app, process.platform, previewContext ?? undefined);
      if (failedProtocolRegistrations.length > 0) {
        console.warn(
          `[main] could not register Windows URL schemes: ${failedProtocolRegistrations.join(", ")}`,
        );
      }

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

      const platformHost = previewContext?.apiOrigin ?? process.env.OPERATOR_GATEWAY_URL ?? DEFAULT_PLATFORM_HOST;
      const runtimeSelectionOrigin = previewContext?.apiOrigin ?? process.env.MATRIX_API_ORIGIN
        ?? (platformHost === DEFAULT_PLATFORM_HOST ? "https://api.matrix-os.com" : platformHost);

      let invalidateAppCapabilities: (() => void) | undefined;
      const auth = new AuthService({
        ...(previewContext ? { previewContext } : {}),
        credentialStore,
        platformHost,
        runtimeSelectionOrigin,
        loadProfile: () => store.get("profile"),
        saveProfile: (profile) => store.set("profile", profile),
        clearProfile: () => store.delete("profile"),
        onAuthChanged: (status) => {
          invalidateAppCapabilities?.();
          nativeAppChatNavigation?.cancelAll();
          navigationCache?.observe(status);
          chatgptPlan?.cancelAll();
          chatgptPlan?.resume();
          fileDownloads?.cancelAll();
          organizationDriveTransfers?.cancelAll();
          localChatImports?.cancelAll();
          sendEvent("auth:changed", {
            signedIn: status.signedIn,
            ...(status.signedIn ? {
              handle: status.handle,
              ...(status.displayName ? { displayName: status.displayName } : {}),
              ...(status.imageUrl ? { imageUrl: status.imageUrl } : {}),
            } : {}),
          });
        },
      });
      await auth.init();
      navigationCache = createNavigationCache({ dir: userData, getStatus: () => auth.getStatus() });
      registerNavigationCacheIpc(ipcMain, navigationCache, rawEvent => {
        const event = rawEvent as IpcMainInvokeEvent;
        const contents = mainWindow?.webContents;
        const rendererUrl = desktopRendererUrl ?? pathToFileURL(join(__dirname, "../renderer/index.html")).toString();
        return !!contents && !contents.isDestroyed() && event.sender === contents
          && event.senderFrame === contents.mainFrame && contents.getURL() === rendererUrl;
      });
      // Failure-only metadata stays in this app/profile's logs; no credential
      // profile files or other applications' logs are read by the recorder.
      try {
        planDiagnostics = createPlanDiagnosticStore({ directory: planDiagnosticDirectory(app.getPath("logs"), userData) });
      } catch (error: unknown) {
        console.warn("[chatgpt-plan] diagnostic_start_failed");
      }
      chatgptPlan = createNativeChatgptPlanService({
        auth, vault: createPlanVault({ dir: userData, safeStorage }),
        fetchFn: fetchNativePlan,
        openBrowser: async url => {
          const authorizationUrl = safeChatgptAuthorizationUrl(url);
          if (!authorizationUrl) throw new Error("invalid authorization URL");
          await shell.openExternal(authorizationUrl);
        },
      });
      chatgptPlan.resume();
      registerChatgptPlanIpc(ipcMain, chatgptPlan, rawEvent => {
        const event = rawEvent as IpcMainInvokeEvent;
        const contents = mainWindow?.webContents;
        const rendererUrl = desktopRendererUrl ?? pathToFileURL(join(__dirname, "../renderer/index.html")).toString();
        return !!contents && !contents.isDestroyed() && event.sender === contents
          && event.senderFrame === contents.mainFrame && contents.getURL() === rendererUrl;
      });

      const rendererOrigin = desktopRendererUrl
        ? new URL(desktopRendererUrl).origin
        : "null";
      // Renderer session gets origin-scoped bearer injection; embed partitions
      // (separate sessions) never do (lesson L1).
      installHeaderInjection(
        session.defaultSession,
        () => auth.getToken(),
        () => auth.getGatewayOrigin(),
        rendererOrigin,
      );
      // The renderer is a different origin than the gateway (file:// in prod,
      // localhost in dev), so allow its cross-origin fetches to the gateway.
      installGatewayCors(session.defaultSession, () => auth.getGatewayOrigin(), rendererOrigin);
      installSupportMessageAnalytics(
        session.defaultSession,
        () => auth.getGatewayOrigin(),
        (detail) => sendEvent("analytics:capture", detail),
      );

      // The Terminal window has its own session: per-computer bearers are
      // attached there by target computer, never the selected-computer token.
      const terminalSession = session.fromPartition(TERMINAL_WINDOW_PARTITION);
      const terminalCredentials = createComputerCredentialBroker({ auth });
      const terminalAuth = installTerminalWindowAuth(terminalSession, { broker: terminalCredentials, getGatewayOrigin: () => auth.getGatewayOrigin() });
      // Signing out forgets the minted bearers and the record of which was last sent.
      computerCredentials = { clear: () => { terminalCredentials.clear(); terminalAuth.clear(); } };
      installGatewayCors(terminalSession, () => auth.getGatewayOrigin(), rendererOrigin);

      nativeAppChatNavigation = createNativeAppChatNavigationBroker({
        emit: (event) => sendEvent("app:open-chat", event),
        cancel: (event) => sendEvent("app:open-chat-cancel", event),
      });
      registerNativeAppChatCompletionIpc(ipcMain, nativeAppChatNavigation, rawEvent => {
        const event = rawEvent as IpcMainInvokeEvent;
        const contents = mainWindow?.webContents;
        const rendererUrl = desktopRendererUrl ?? pathToFileURL(join(__dirname, "../renderer/index.html")).toString();
        return !!contents && !contents.isDestroyed() && event.sender === contents
          && event.senderFrame === contents.mainFrame && contents.getURL() === rendererUrl;
      });

      const nativeAppBridge = new NativeAppBridge({
        getSenderLifecycle: (senderId) => webContents.fromId(senderId) ?? undefined,
        resolveApp: createNativeAppOpenResolver({ getGatewayOrigin: () => auth.getGatewayOrigin(), getToken: () => auth.getToken() }),
        openApp: (app) => {
          const status = auth.getStatus();
          if (!status.signedIn || !mainWindow || mainWindow.isDestroyed()) throw new Error("App launch is unavailable");
          sendEvent("app:open", { ...app, runtimeSlot: status.runtimeSlot, authGeneration: status.authGeneration });
        },
        openChat: async (request, signal) => {
          const status = auth.getStatus();
          if (!status.signedIn || !mainWindow || mainWindow.isDestroyed() || !nativeAppChatNavigation) {
            throw new Error("Chat navigation is unavailable");
          }
          focusMainWindow();
          await nativeAppChatNavigation.request(request, {
            runtimeSlot: status.runtimeSlot,
            authGeneration: status.authGeneration,
          }, signal);
        },
        authGeneration: () => auth.getStatus().authGeneration,
        generate: (app, context) => {
          const status = auth.getStatus();
          if (!status.signedIn || !mainWindow || mainWindow.isDestroyed()) throw new Error("App task is unavailable");
          sendEvent("app:generate", { app, context, runtimeSlot: status.runtimeSlot, authGeneration: status.authGeneration });
        },
        capabilityRequest: createNativeAppCapabilityRequester({
          getGatewayOrigin: () => auth.getGatewayOrigin(),
          getToken: () => auth.getToken(),
        }),
        aiRoutesRequest: createNativeAppAiRoutesRequester({
          getGatewayOrigin: () => auth.getGatewayOrigin(),
          getToken: () => auth.getToken(),
        }),
        aiRequest: createNativeAppAiRequester({
          getGatewayOrigin: () => auth.getGatewayOrigin(),
          getToken: () => auth.getToken(),
        }),
        gatewayRequest: createNativeAppGatewayRequester({
          getGatewayOrigin: () => auth.getGatewayOrigin(),
          getToken: () => auth.getToken(),
          getAuthGeneration: () => auth.getStatus().authGeneration,
          installBrowserSessionCookie: (headers, origin, isCurrent) => installBrowserProductSessionCookie(
            headers, origin, isCurrent, session.fromPartition("persist:app-browser-lab").cookies),
        }),
        gatewayOrigin: () => auth.getGatewayOrigin(),
        request: createNativeAppQueryRequester({
          getGatewayOrigin: () => auth.getGatewayOrigin(),
          getToken: () => auth.getToken(),
        }),
      });
      invalidateAppCapabilities = () => nativeAppBridge.clear();
      nativeAppBridge.registerIpc(ipcMain);

      const embeds = new EmbedService({
        getWindow: () => mainWindow,
        getGatewayOrigin: () => auth.getGatewayOrigin(),
        getToken: () => auth.getToken(),
        emitState: (embedId, state) => sendEvent("embed:state", { embedId, state }),
        appBridge: nativeAppBridge,
        appPreloadPath: join(__dirname, "../preload/index.cjs"),
        browserLabViewerAuth: {
          getGatewayOrigin: () => auth.getGatewayOrigin(),
          getToken: () => auth.getToken(),
          getAuthGeneration: () => auth.getStatus().authGeneration,
        },
        renewBrowserProductSession: () => createNativeAppGatewayRequester({
          getGatewayOrigin: () => auth.getGatewayOrigin(), getToken: () => auth.getToken(),
          getAuthGeneration: () => auth.getStatus().authGeneration,
          installBrowserSessionCookie: (headers, origin, isCurrent) => installBrowserProductSessionCookie(headers, origin, isCurrent, session.fromPartition("persist:app-browser-lab").cookies),
        })("matrix-browser", { url: "/api/apps/browser-lab/session", init: { method: "POST", body: "{}" } }, "browser-lab"),
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
      }, { previewContext: previewContext ?? undefined });
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
      handleAnalyticsBeforeQuit = createAnalyticsBeforeQuit({
        requestFlush: () => new Promise<void>((resolve) => {
          completePendingAnalyticsFlush = resolve;
          sendEvent("analytics:flush-requested", {});
        }),
        quit: () => app.quit(),
        timeoutMs: 750,
      });
      const codingAgentThreadEvents = createCodingAgentThreadEventStreamer({
        auth,
        emit: sendEvent,
      });
      closeCodingAgentThreadEvents = () => codingAgentThreadEvents.closeAll();

      fileDownloads = createFileDownloadService({
        auth,
        chooseDestination: async (filename) => {
          const options = {
            title: "Download file",
            defaultPath: join(app.getPath("downloads"), filename),
            buttonLabel: "Save",
            properties: ["createDirectory", "showOverwriteConfirmation"] as Array<"createDirectory" | "showOverwriteConfirmation">,
          };
          const result = mainWindow && !mainWindow.isDestroyed()
            ? await dialog.showSaveDialog(mainWindow, options)
            : await dialog.showSaveDialog(options);
          return result.canceled ? null : result.filePath ?? null;
        },
      });
      organizationDriveTransfers = createOrganizationDriveTransferService({
        auth,
        chooseUpload: async () => {
          const options = { title: "Upload to organization drive",
            properties: ["openFile"] as Array<"openFile"> };
          const result = mainWindow && !mainWindow.isDestroyed()
            ? await dialog.showOpenDialog(mainWindow, options)
            : await dialog.showOpenDialog(options);
          return result.canceled || !result.filePaths[0] ? null : readDriveUploadFile(result.filePaths[0]);
        },
        chooseDownload: async (filename) => {
          const options = { title: "Download from organization drive",
            defaultPath: join(app.getPath("downloads"), filename), buttonLabel: "Save",
            properties: ["createDirectory", "showOverwriteConfirmation"] as Array<"createDirectory" | "showOverwriteConfirmation"> };
          const result = mainWindow && !mainWindow.isDestroyed()
            ? await dialog.showSaveDialog(mainWindow, options)
            : await dialog.showSaveDialog(options);
          return result.canceled ? null : result.filePath ?? null;
        },
        saveDownload: saveDriveDownloadFile,
      });
      localChatImports = createNativeChatImportService({auth, progress:progress=>sendEvent("runtime:chat-import-progress",progress),
        discoverSources:signal=>discoverLocalChats({home:app.getPath("home"),codexRoot:process.env.CODEX_HOME,claudeRoot:process.env.CLAUDE_CONFIG_DIR},signal)});
      registerLocalChatImportIpc(ipcMain,localChatImports,rawEvent=>{
        const event=rawEvent as IpcMainInvokeEvent;const contents=mainWindow?.webContents;
        const rendererUrl=desktopRendererUrl??pathToFileURL(join(__dirname,"../renderer/index.html")).toString();
        return !!contents&&!contents.isDestroyed()&&event.sender===contents&&event.senderFrame===contents.mainFrame&&contents.getURL()===rendererUrl;
      });
      const downloads = fileDownloads;
      const driveTransfers = organizationDriveTransfers;
      const packagedRendererPath = join(__dirname, "../renderer/index.html");
      const mainRendererUrl = desktopRendererUrl ?? pathToFileURL(packagedRendererPath).toString();
      const terminalRendererUrl = terminalWindowUrl(mainRendererUrl);
      let reopenMainWindow: (() => Promise<void>) | undefined;
      const terminalWindowController = createTerminalWindowController<BrowserWindow>({
        create: (bounds) => {
          const win = createTerminalBrowserWindow({
            bounds,
            preloadPath: join(__dirname, "../preload/index.cjs"),
            devUrl: desktopRendererUrl ? terminalRendererUrl : null,
            packagedRendererPath,
            query: { [TERMINAL_WINDOW_QUERY_KEY]: TERMINAL_WINDOW_QUERY_VALUE },
            trustedUrl: terminalRendererUrl,
            onLoadError: (error) => logMainError("failed to load Terminal window", error),
          });
          win.on("focus", () => sendTerminalWindowEvent("window:focus-changed", { focused: true }));
          win.on("blur", () => sendTerminalWindowEvent("window:focus-changed", { focused: false }));
          // A window that closes, reloads or crashes cannot detach for itself;
          // without this its local terminal attachments would stay held.
          const releaseLocalTerminals = () => localTerminals?.detachAll();
          win.on("closed", releaseLocalTerminals);
          win.webContents.on("did-start-loading", releaseLocalTerminals);
          win.webContents.on("render-process-gone", releaseLocalTerminals);
          return win;
        },
        loadBounds: () => store.get("terminalWindowBounds"),
        saveBounds: (bounds) => store.set("terminalWindowBounds", bounds),
        fitBounds: (bounds) => fitWindowBoundsToWorkArea(bounds, screen.getDisplayMatching({
          x: bounds.x ?? 0, y: bounds.y ?? 0, width: bounds.width, height: bounds.height,
        }).workArea),
      });
      terminalWindows = terminalWindowController;
      const windowSenders = {
        mainWindow: () => mainWindow,
        terminalWindow: () => terminalWindowController.current(),
        mainUrl: mainRendererUrl,
        terminalUrl: terminalRendererUrl,
      };
      const authorizeSender = createSenderPolicy(windowSenders);
      const localRuntime = resolveLocalTerminalRuntime({
        isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, userData, home: homedir(), env: process.env,
      });
      const localTerminalHost = createLocalTerminalHost({
        ...localRuntime,
        expectedVersion: LOCAL_TERMINAL_VERSION,
        home: homedir(),
        shell: localLoginShell(process.env, () => userInfo().shell),
        env: process.env,
        uid: userInfo().uid,
        startCore: startLocalTerminalCore,
        openSocket: (path) => connectSocket(path),
      }, {
        output: (attachId, data) => sendTerminalWindowEvent("local-terminal:output", { attachId, data }),
        closed: (attachId) => sendTerminalWindowEvent("local-terminal:closed", { attachId }),
      });
      localTerminals = localTerminalHost;
      registerLocalTerminalIpc(ipcMain, localTerminalHost, authorizeSender);
      // Both trusted windows host terminals, so both may read copied files.
      registerTerminalClipboardIpc(ipcMain, {
        clipboard,
        isTrustedSender: (event) => senderRole(windowSenders, event) !== null,
      });
      registerIpcHandlers(ipcMain, {
        authorizeSender,
        // Windows is out of scope for the Terminal window (spec 651).
        openTerminalWindow: () => process.platform === "win32"
          ? Promise.reject(new Error("invalid request"))
          : terminalWindowController.openOrFocus(),
        focusMainWindow: () => {
          if (mainWindow && !mainWindow.isDestroyed()) { focusMainWindow(); return; }
          void reopenMainWindow?.().catch((error: unknown) => logMainError("window restore failed", error));
        },
        downloadFile: (request) => downloads.download(request),
        cancelFileDownload: (requestId) => downloads.cancel(requestId),
        uploadOrganizationDrive: (request) => driveTransfers.upload(request),
        downloadOrganizationDrive: (request) => driveTransfers.download(request),
        cancelOrganizationDriveTransfer: () => { driveTransfers.cancelAll(); return { ok: true }; },
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
          navigationCache?.observe(auth.getStatus());
          chatgptPlan?.cancelAll();
          chatgptPlan?.resume();
          downloads.cancelAll();
          driveTransfers.cancelAll();
          localChatImports?.cancelAll();
          nativeAppChatNavigation?.cancelAll();
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
        toggleWindowMaximize: () => {
          if (!mainWindow || mainWindow.isDestroyed()) return;
          if (mainWindow.isMaximized()) mainWindow.unmaximize();
          else mainWindow.maximize();
        },
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
        getPreviewContext: () => previewContext ? { role: previewContext.role, pr: previewContext.pr,
          sourceSha: previewContext.sourceSha, handle: previewContext.handle, organizationId: previewContext.organizationId } : null,
        getAppVersion: () => app.getVersion(),
        buildSource: readDesktopBuildSource(),
        completeAnalyticsFlush: () => {
          completePendingAnalyticsFlush?.();
          completePendingAnalyticsFlush = null;
        },
        fetchSupportIdentity: () => fetchDesktopSupportIdentity(auth),
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
          nativeAppChatNavigation?.cancelAll();
          mainWindow = null;
        });
      };

      await openMainWindow();
      // Single-flight: the menu, the Terminal window and app activation can all
      // ask for the main window while one is still being created.
      let reopening: Promise<void> | null = null;
      reopenMainWindow = () => {
        if (mainWindow && !mainWindow.isDestroyed()) { focusMainWindow(); return Promise.resolve(); }
        reopening ??= (reopenPreviewWindow ? reopenPreviewWindow() : openMainWindow()).finally(() => { reopening = null; });
        return reopening;
      };
      if (previewContext) reopenPreviewWindow = createPreviewWindowReopener({
        current: () => mainWindow, open: openMainWindow, focus: focusMainWindow,
      });
      installAppMenu({
        mainWindow: () => mainWindow,
        terminalWindow: () => terminalWindowController.current(),
        thirdPartyNoticesPath: localRuntime.noticesPath,
        focusMain: focusMainWindow,
        restoreMain: () => {
          void reopenMainWindow?.().catch((error: unknown) => logMainError("window restore failed", error));
        },
        checkForUpdates: () => {
          focusMainWindow();
          void updater.check();
        },
        openTerminalWindow: () => {
          void terminalWindowController.openOrFocus()
            .catch((error: unknown) => logMainError("failed to open Terminal window", error));
        },
      });

      void updater.check();
      updateCheckTimer = setInterval(() => {
        void updater.check();
      }, 60 * 60 * 1000);

      app.on("activate", () => {
        // The Terminal window may outlive the main window; restore the main one regardless.
        if (!mainWindow || mainWindow.isDestroyed()) {
          // Through the shared single-flight path, so activation cannot race a
          // menu or Terminal-window request into creating a second window.
          void reopenMainWindow?.().catch((error: unknown) => logMainError("window restore failed", error));
        }
      });
    })
    .catch((err: unknown) => {
      logMainError("failed to start app", err);
    });

  app.on("before-quit", (event) => {
    organizationDriveTransfers?.cancelAll();
    nativeAppChatNavigation?.cancelAll();
    if (handleAnalyticsBeforeQuit?.(event)) return;
    if (!navigationCacheDrained && navigationCache) {
      event.preventDefault();
      if (!drainingNavigationCache) {
        drainingNavigationCache = true;
        void navigationCache.drain().catch((error: unknown) => logMainError("navigation cache cleanup failed", error))
          .finally(() => { navigationCacheDrained = true; app.quit(); });
      }
      return;
    }
    if (!planDrained && chatgptPlan) {
      event.preventDefault();
      if (!drainingPlan) {
        drainingPlan = true;
        void chatgptPlan.dispose().catch((error: unknown) => logMainError("subscription cleanup failed", error))
          .finally(() => { planDrained = true; app.quit(); });
      }
      return;
    }
    // Dispose the subscription first so peer shutdown failures can still be
    // recorded, then drain diagnostics for at most the store's one-second cap.
    if (!planDiagnosticsDrained && planDiagnostics) {
      event.preventDefault();
      if (!drainingPlanDiagnostics) {
        drainingPlanDiagnostics = true;
        void planDiagnostics.close().catch((error: unknown) => {
          console.warn("[chatgpt-plan] diagnostic_close_failed");
        }).finally(() => { planDiagnosticsDrained = true; app.quit(); });
      }
      return;
    }
    if(!importsDrained&&localChatImports){
      event.preventDefault();
      if(!drainingImports){drainingImports=true;void localChatImports.dispose().catch((error:unknown)=>logMainError("import cleanup failed",error)).finally(()=>{importsDrained=true;app.quit();});}
      return;
    }
    if (!downloadsDrained && fileDownloads) {
      event.preventDefault();
      if (!drainingDownloads) {
        drainingDownloads = true;
        void fileDownloads.dispose().catch((error: unknown) => logMainError("download cleanup failed", error))
          .finally(() => { downloadsDrained = true; app.quit(); });
      }
      return;
    }
    if (updateCheckTimer) {
      clearInterval(updateCheckTimer);
      updateCheckTimer = null;
    }
    closeCodingAgentThreadEvents?.();
    closeCodingAgentThreadEvents = null;
    terminalWindows?.dispose();
    terminalWindows = null;
    computerCredentials?.clear();
    computerCredentials = null;
    // Detach only: the local core and its terminals outlive the app.
    localTerminals?.dispose();
    localTerminals = null;
    handleUpdateBeforeQuit?.(event);
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
