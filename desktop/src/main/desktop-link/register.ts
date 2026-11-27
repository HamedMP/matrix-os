// Wires the desktop link service (spec 2716) into Electron main: 2698's pairing
// (identity, key and Full Access), the owner's native approvals, this app's
// private core, the computer bearers, wake and network events, sign-out and
// quit. Inert until this device is paired with the primary computer.
import { hostname, release } from "node:os";
import { pairingDeviceNoun, type PairedLinkIdentity } from "../desktop-pairing";
import type { LocalTerminalHost } from "../local-terminals/host";
import { renderVisible, type DesktopLinkConsentRequest } from "./consent";
import { localTerminalCoreSocket, localTerminalRuntimeDir } from "../local-terminals/runtime";
import { collectDesktopInventory, standardHerdrSocket, type ReadMatrixInventory } from "./herdr-inventory";
import { registerDesktopLinkIpc } from "./ipc";
import { createDesktopLinkPreferenceStore } from "./preferences";
import { createDesktopLinkService, type DesktopLinkService, type DesktopLinkSocket } from "./service";

export type { DesktopLinkService } from "./service";

interface PowerMonitorLike { on(event: "resume" | "unlock-screen", listener: () => void): unknown }

export interface DesktopLinkMainOptions {
  userData: string;
  home: string;
  appVersion: string;
  matrixInventory?: ReadMatrixInventory;
  localTerminals: Pick<LocalTerminalHost, "openStream">;
  /** 2698's pairing: the link proves this device's pairing key at the current revision. */
  pairing: {
    linkIdentity(signal: AbortSignal): Promise<PairedLinkIdentity | null>;
    linkFullAccess(identity: PairedLinkIdentity): Promise<boolean>;
    open(): Promise<void>;
  };
  /** Local owner consent. Close the prompt when the link request is aborted. */
  showDialog(request: {
    type: "question"; title: string; message: string; detail: string; buttons: string[]; defaultId: number; cancelId: number;
    signal: AbortSignal;
  }): Promise<{ response: number }>;
  computerToken(slot: string): Promise<string | null>;
  powerMonitor: PowerMonitorLike;
  /** The Terminal window's controls: status, switch on and off. */
  ipc?: {
    ipcMain: Parameters<typeof registerDesktopLinkIpc>[0];
    authorizeSender: Parameters<typeof registerDesktopLinkIpc>[2];
    emit: Parameters<typeof registerDesktopLinkIpc>[3];
  };
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
    case "remote-terminal":
      return {
        message: `${who} wants to use a terminal on “${request.machine}”`,
        detail: `Terminal: ${request.terminal}\nProgram: ${request.program}\nFolder: ${request.cwd}\nTitle (set by the program): ${request.title}\n\nAllow this Chat request to read, type into, and interrupt this remote terminal through this ${noun}. ${legend}`,
      };
    case "screenshot":
      return { message: `${who} wants to take a screenshot of this ${noun}`, detail: `It sees everything on your screen right now. ${tip}` };
  }
}

export function startDesktopLink(options: DesktopLinkMainOptions): DesktopLinkService {
  const platform = process.platform;
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
    openCore: () => options.localTerminals.openStream(),
    readInventory: platform === "darwin" ? (ownerId) => collectDesktopInventory({
      privateCore: localTerminalCoreSocket(localTerminalRuntimeDir(options.userData, options.home)),
      defaultCore: standardHerdrSocket(process.env, options.home),
    }, ownerId, options.matrixInventory) : undefined,
    preferences: createDesktopLinkPreferenceStore(options.userData),
    home: options.home,
    deviceName: (options.deviceName ?? hostname().replace(/\.local$/, "")).slice(0, 64) || "desktop",
    app: { version: options.appVersion, os: `macOS ${release()}`.slice(0, 64) },
    // Electron main's WebSocket (Node's) takes headers, so the bearer never sits in a URL.
    createSocket: (url, headers) => new WebSocket(url, { headers } as unknown as string[]) as unknown as DesktopLinkSocket,
  });
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
