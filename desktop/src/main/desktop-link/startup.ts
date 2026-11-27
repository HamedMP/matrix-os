import type { BaseWindow } from "electron";
import type { AuthService } from "../auth/auth-service";
import { createDesktopPairing } from "../desktop-pairing";
import { showDesktopLinkDialog } from "../desktop-pairing/dialog";
import { readMatrixInventory } from "./matrix-inventory";
import { startDesktopLink, type DesktopLinkMainOptions, type DesktopLinkService } from "./register";

type PairingOptions = Parameters<typeof createDesktopPairing>[0];
type StartupOptions = Pick<DesktopLinkMainOptions, "userData" | "home" | "appVersion" | "localTerminals" | "computerToken" | "powerMonitor" | "ipc"> & {
  auth: AuthService;
  safeStorage: PairingOptions["safeStorage"];
  window(): BaseWindow | null;
  onError(message: string, error: unknown): void;
};

export function startPairedDesktop({ auth, safeStorage, window, onError, ...options }: StartupOptions) {
  let link: DesktopLinkService;
  const pairing = createDesktopPairing({
    auth, safeStorage, userData: options.userData, window, desktopLinkAvailable: true,
    onPaired() {
      const status = auth.getStatus();
      if (status.signedIn) void link.enable("primary", status.handle)
        .catch((error: unknown) => onError("desktop link did not start", error));
    },
    onDisconnecting() {
      void link.disable("primary").catch((error: unknown) => onError("desktop link did not stop", error));
    },
  });
  link = startDesktopLink({
    ...options, pairing, matrixInventory: (ownerId) => readMatrixInventory(auth, ownerId),
    showDialog: (request) => showDesktopLinkDialog(window(), request),
  });
  link.seedAccount(auth.getStatus());
  return { pairing, link };
}
