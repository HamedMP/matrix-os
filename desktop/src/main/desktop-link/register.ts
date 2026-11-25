// Wires the Desktop link service (spec 2716) into Electron main: the shared device
// key store, this app's private core, the Terminal window's computer bearers,
// wake and network events, sign-out and quit. Inert until the person switches
// it on for a computer.
import { hostname, release } from "node:os";
import type { DesktopLinkDeviceInfo } from "@matrix-os/contracts/desktop-link";
import type { SafeStorageLike } from "../auth/credential-store";
import { createPairingKeyStore, type PairingSafeStorage } from "../desktop-pairing/key-store";
import type { LocalTerminalHost } from "../local-terminals/host";
import { registerDesktopLinkIpc } from "./ipc";
import { createDesktopLinkPreferenceStore } from "./preferences";
import { createDesktopScreenshot, type ScreenSource } from "./screenshot";

const OS_NAMES: Partial<Record<NodeJS.Platform, string>> = { darwin: "macOS", linux: "Linux", win32: "Windows" };
import { createDesktopLinkService, type DesktopLinkService, type DesktopLinkSocket } from "./service";

export type { DesktopLinkService } from "./service";

interface PowerMonitorLike { on(event: "resume" | "unlock-screen", listener: () => void): unknown }

export interface DesktopLinkMainOptions {
  userData: string;
  home: string;
  appVersion: string;
  safeStorage: SafeStorageLike & PairingSafeStorage;
  localTerminals: Pick<LocalTerminalHost, "openStream">;
  auth: { getGatewayOrigin(): string | null; getStatus(): { signedIn: boolean; userId?: string } };
  computerToken(slot: string): Promise<string | null>;
  powerMonitor: PowerMonitorLike;
  /** Electron's capture APIs, for screenshots the computer asks for on every OS. */
  electron?: {
    desktopCapturer: { getSources(options: { types: ["screen"]; thumbnailSize: { width: number; height: number } }): Promise<ScreenSource[]> };
    screen: { getPrimaryDisplay(): { id: number; size: { width: number; height: number }; scaleFactor: number } };
    systemPreferences: { getMediaAccessStatus(mediaType: "screen"): string };
  };
  platform?: NodeJS.Platform;
  arch?: string;
  /** Registers the quit hook: every link says goodbye and closes as the app quits. */
  quitting(listener: () => void): void;
  /** The Terminal window's controls: status, switch on and off. */
  ipc?: {
    ipcMain: Parameters<typeof registerDesktopLinkIpc>[0];
    authorizeSender: Parameters<typeof registerDesktopLinkIpc>[2];
    emit: Parameters<typeof registerDesktopLinkIpc>[3];
  };
  /** What the computer shows for this device; the macOS computer name when available. */
  deviceName?: string;
}

/** What this desktop reports about itself on every connect. */
export function desktopDeviceInfo(platform: "darwin" | "linux" | "win32", arch: string, canCapture: boolean): DesktopLinkDeviceInfo {
  return {
    platform,
    arch: arch === "arm64" ? "arm64" : "x64",
    // Mouse and keyboard control is a later spec (ENG-495): never offered here.
    capabilities: { terminals: true, screenshot: canCapture, input: false },
  };
}

export function startDesktopLink(options: DesktopLinkMainOptions): DesktopLinkService {
  const keys = createPairingKeyStore(options.userData, options.safeStorage);
  const platform = options.platform ?? process.platform;
  const electron = options.electron;
  const arch = options.arch ?? process.arch;
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") throw new Error("desktop link unsupported here");
  const service = createDesktopLinkService({
    gatewayOrigin: () => options.auth.getGatewayOrigin(),
    ownerId: () => {
      const status = options.auth.getStatus();
      return status.signedIn && status.userId ? status.userId : null;
    },
    credential: (slot) => options.computerToken(slot),
    keys,
    openCore: () => options.localTerminals.openStream(),
    preferences: createDesktopLinkPreferenceStore(options.userData),
    home: options.home,
    deviceName: (options.deviceName ?? hostname().replace(/\.local$/, "")).slice(0, 64) || "desktop",
    app: { version: options.appVersion, os: `${OS_NAMES[platform] ?? platform} ${release()}`.slice(0, 64) },
    device: desktopDeviceInfo(platform, arch, Boolean(electron)),
    // Electron main's WebSocket (Node's) takes headers, so the bearer never sits in a URL.
    createSocket: (url, headers) => new WebSocket(url, { headers } as unknown as string[]) as unknown as DesktopLinkSocket,
    ...(electron ? { screenshot: createDesktopScreenshot({
      platform,
      // Only macOS gates screen capture per app; elsewhere the session decides.
      screenAccess: () => (platform === "darwin" ? electron.systemPreferences.getMediaAccessStatus("screen") : "granted"),
      getSources: (request) => electron.desktopCapturer.getSources(request),
      primaryDisplay: () => {
        const display = electron.screen.getPrimaryDisplay();
        return { id: display.id, width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) };
      },
    }) } : {}),
  });
  options.quitting(() => service.dispose());
  if (options.ipc) registerDesktopLinkIpc(options.ipc.ipcMain, service, options.ipc.authorizeSender, options.ipc.emit);
  const wake = () => service.wake();
  options.powerMonitor.on("resume", wake);
  options.powerMonitor.on("unlock-screen", wake);
  void service.start().catch((error: unknown) => {
    console.warn("[desktop-link] start failed:", error instanceof Error ? error.name : "UnknownError");
  });
  return service;
}
