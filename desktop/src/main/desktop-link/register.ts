// Wires the Desktop link service (spec 2716) into Electron main: the shared device
// key store, this app's private core, the Terminal window's computer bearers,
// wake and network events, sign-out and quit. Inert until the person switches
// it on for a computer.
import { hostname, release } from "node:os";
import type { SafeStorageLike } from "../auth/credential-store";
import { createPairingKeyStore, type PairingSafeStorage } from "../desktop-pairing/key-store";
import type { LocalTerminalHost } from "../local-terminals/host";
import { registerDesktopLinkIpc } from "./ipc";
import { createDesktopLinkPreferenceStore } from "./preferences";
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

export function startDesktopLink(options: DesktopLinkMainOptions): DesktopLinkService {
  const keys = createPairingKeyStore(options.userData, options.safeStorage);
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
    app: { version: options.appVersion, os: `macOS ${release()}`.slice(0, 64) },
    // Electron main's WebSocket (Node's) takes headers, so the bearer never sits in a URL.
    createSocket: (url, headers) => new WebSocket(url, { headers } as unknown as string[]) as unknown as DesktopLinkSocket,
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
