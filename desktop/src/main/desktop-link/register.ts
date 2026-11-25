// Wires the desktop link service (spec 2716) into Electron main: 2698's pairing
// (identity, key and Full Access), the owner's native approvals, this app's
// private core, the computer bearers, wake and network events, sign-out and
// quit. Inert until this device is paired with the primary computer.
import { hostname, release } from "node:os";
import type { DesktopLinkDeviceInfo } from "@matrix-os/contracts/desktop-link";
import { pairingDeviceNoun, type PairedLinkIdentity } from "../desktop-pairing";
import type { MacActivityHandle } from "../mac-activity/activity";
import type { LocalTerminalHost } from "../local-terminals/host";
import { renderVisible, type DesktopLinkConsentRequest } from "./consent";
import { registerDesktopLinkIpc } from "./ipc";
import { createDesktopLinkPreferenceStore } from "./preferences";
import { createWindowsCore, type SpawnWindowsPty, type WindowsCore } from "./windows-core";
import { createDesktopScreenshot, type ScreenSource } from "./screenshot";
import { createDesktopLinkService, type DesktopLinkService, type DesktopLinkSocket } from "./service";

export type { DesktopLinkService } from "./service";

const OS_NAMES: Partial<Record<NodeJS.Platform, string>> = { darwin: "macOS", linux: "Linux", win32: "Windows" };

interface PowerMonitorLike { on(event: "resume" | "unlock-screen", listener: () => void): unknown }

export interface DesktopLinkMainOptions {
  userData: string;
  home: string;
  appVersion: string;
  localTerminals: Pick<LocalTerminalHost, "openStream">;
  /** 2698's pairing: the link proves this device's pairing key at the current revision. */
  pairing: {
    linkIdentity(signal: AbortSignal): Promise<PairedLinkIdentity | null>;
    linkFullAccess(identity: PairedLinkIdentity): Promise<boolean>;
    open(): Promise<void>;
  };
  /** 2698's activity indicator, where it runs: the link shows there while it is on, with Stop. */
  activity?: (kind: "desktop-link") => MacActivityHandle | undefined;
  /** A native dialog on this desktop (2698's), for the owner's approvals; closes when `signal` aborts. */
  showDialog(request: {
    type: "question"; title: string; message: string; detail: string; buttons: string[]; defaultId: number; cancelId: number;
    signal: AbortSignal;
  }): Promise<{ response: number }>;
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
  /** On Windows, where herdr-core has no build: node-pty's spawn, loaded only there. */
  loadWindowsPty?(): Promise<SpawnWindowsPty>;
  /** What the computer shows for this device; the macOS computer name when available. */
  deviceName?: string;
}

/** The native approval's words for one request from the paired computer (spec 2716, D2). */
export function desktopLinkApproval(computerName: string, request: DesktopLinkConsentRequest, platform: NodeJS.Platform) {
  const noun = pairingDeviceNoun(platform);
  // The computer's name comes from the pairing: shown as written, inside a fixed phrase it cannot replace.
  const named = renderVisible(computerName.trim(), 64);
  const who = named ? `Your Matrix computer “${named}”` : "Your Matrix computer";
  const tip = "To stop being asked, allow Desktop Link Full Access in pairing.";
  const legend = "Characters that would not show are written as ⟨U+…⟩.";
  switch (request.kind) {
    case "run":
      return {
        message: `${who} wants to run a command on this ${noun}`,
        detail: `Command:\n${request.command}\n\nFolder: ${request.cwd}\n\nIt runs as you, and the computer can then see and type into that terminal. ${legend} ${tip}`,
      };
    case "terminal":
      return {
        message: request.action === "end"
          ? `${who} wants to end terminal ${request.terminal} on this ${noun}`
          : `${who} wants to open terminal ${request.terminal} on this ${noun}`,
        detail: `Program: ${request.program}\nFolder: ${request.cwd}\nTitle (set by the program): ${request.title}\n\n${
          request.action === "end" ? "Its program stops, and anything unsaved in it is lost." : "It could read what is on its screen, type into it and end it."} ${legend} ${tip}`,
      };
    case "screenshot":
      return { message: `${who} wants to take a screenshot of this ${noun}`, detail: `It sees everything on your screen right now. ${tip}` };
  }
}

/**
 * One activity entry while the link to the paired computer is on: running,
 * then stopped, revoked (pairing removed) or failed when it ends. Reconnecting
 * after a drop keeps the same entry.
 */
export function bridgeDesktopLinkActivity(
  service: Pick<DesktopLinkService, "onStatus">,
  begin: (kind: "desktop-link") => MacActivityHandle | undefined,
): () => void {
  let entry: MacActivityHandle | undefined;
  return service.onStatus((status) => {
    if (status.slot !== "primary") return;
    if (status.state === "on") {
      entry ??= begin("desktop-link");
      entry?.update("running");
      return;
    }
    if (status.state === "connecting" || status.state === "offline") return;
    entry?.finish(status.state === "removed" ? "revoked" : status.state === "error" ? "failed" : "stopped");
    entry = undefined;
  });
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

/** The environment PowerShell starts with: the user's own, minus anything Electron-only. */
export function windowsShellEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || /^(ELECTRON_|NODE_OPTIONS$|MATRIX_)/i.test(name)) continue;
    env[name] = value;
  }
  return env;
}

export function startDesktopLink(options: DesktopLinkMainOptions): DesktopLinkService {
  const platform = options.platform ?? process.platform;
  const electron = options.electron;
  // Built on first use; its terminals end when the app quits.
  let windows: Promise<WindowsCore> | null = null;
  const windowsCore = (): Promise<WindowsCore> => {
    if (!options.loadWindowsPty) return Promise.reject(new Error("windows terminals unavailable"));
    windows ??= options.loadWindowsPty().then((spawn) => createWindowsCore({ spawn, home: options.home, env: windowsShellEnv(process.env) }));
    return windows;
  };
  const arch = options.arch ?? process.arch;
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") throw new Error("desktop link unsupported here");
  const service = createDesktopLinkService({
    pairing: options.pairing,
    credential: (slot) => options.computerToken(slot),
    consent: {
      async ask(computerName, request, signal) {
        const words = desktopLinkApproval(computerName, request, platform);
        const { response } = await options.showDialog({
          type: "question", title: "Matrix OS", ...words, buttons: ["Don't Allow", "Allow"], defaultId: 0, cancelId: 0, signal,
        });
        return response === 1;
      },
      fullAccess: (identity) => options.pairing.linkFullAccess(identity),
    },
    // macOS and Linux: the app's private herdr-core. Windows: the ConPTY core.
    openCore: platform === "win32" ? () => windowsCore().then((core) => core.openStream()) : () => options.localTerminals.openStream(),
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
  options.quitting(() => {
    service.dispose();
    void windows?.then((core) => core.dispose(), (error: unknown) => {
      console.warn("[desktop-link] windows terminals did not start:", error instanceof Error ? error.name : "UnknownError");
    });
  });
  if (options.activity) bridgeDesktopLinkActivity(service, options.activity);
  if (options.ipc) {
    registerDesktopLinkIpc(options.ipc.ipcMain, service, options.ipc.authorizeSender, options.ipc.emit, () => options.pairing.open());
  }
  const wake = () => service.wake();
  options.powerMonitor.on("resume", wake);
  options.powerMonitor.on("unlock-screen", wake);
  void service.start().catch((error: unknown) => {
    console.warn("[desktop-link] start failed:", error instanceof Error ? error.name : "UnknownError");
  });
  return service;
}
