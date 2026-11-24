"use client";

import { DesktopMachinesGroup, useDesktopMachines, type DesktopLinkRequest } from "@matrix-os/ui/desktop-link";
import { getGatewayUrl } from "@/lib/gateway";
import { desktopShellSession } from "./herdr-shell-session";
import type { ShellSessionSummary } from "./terminal-session-state";

/** The gateway transport for `/api/desktop-link`, bounded like every shell request. */
const shellDesktopLinkRequest: DesktopLinkRequest = (path, init) => fetch(`${getGatewayUrl()}${path}`, {
  method: init.method,
  ...(init.body !== undefined ? { body: init.body } : {}),
  ...(init.headers ? { headers: init.headers } : {}),
  signal: init.signal ?? AbortSignal.timeout(10_000),
});

/** The owner's linked desktops over the shell's gateway transport. */
export function useShellDesktopMachines() {
  return useDesktopMachines({ request: shellDesktopLinkRequest });
}

export type ShellDesktopMachinesState = ReturnType<typeof useShellDesktopMachines>;

/** "Desktops" after Herdr sessions, on Web Desktop and Web Canvas (spec 2716). */
export function ShellDesktopMachines({ desktops, selectedSessionId, onOpen }: {
  desktops: ShellDesktopMachinesState;
  selectedSessionId: string | null;
  onOpen(shell: ShellSessionSummary): void;
}) {
  return (
    <DesktopMachinesGroup
      state={desktops}
      selectedRefKey={selectedSessionId}
      onOpen={(deviceId, session) => onOpen(desktopShellSession(deviceId, session))}
      style={{ color: "var(--terminal-drawer-fg)", maxHeight: "40%", overflowY: "auto" }}
    />
  );
}
