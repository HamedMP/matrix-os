"use client";

import { HerdrSessionsGroup, useHerdrSessions, type HerdrSessionsRequest } from "@matrix-os/ui/herdr-sessions";
import { getGatewayUrl } from "@/lib/gateway";
import { herdrShellSession } from "./herdr-shell-session";
import type { ShellSessionSummary } from "./terminal-session-state";

const request: HerdrSessionsRequest = (path, init) => fetch(`${getGatewayUrl()}${path}`, {
  ...init,
  signal: init.signal ?? AbortSignal.timeout(10_000),
});

/** "Herdr sessions" after the project workspaces, on Web Desktop and Web Canvas (spec 2701). */
export function ShellHerdrSessions({ selectedSessionId, onOpen }: {
  selectedSessionId: string | null;
  onOpen(shell: ShellSessionSummary): void;
}) {
  const herdr = useHerdrSessions({ request });
  return (
    <HerdrSessionsGroup
      list={herdr.list}
      selectedRefKey={selectedSessionId}
      closingIds={herdr.closingIds}
      error={herdr.error}
      onOpen={(session) => onOpen(herdrShellSession(session))}
      onClose={(session) => herdr.close(session.id)}
      style={{ color: "var(--terminal-drawer-fg)", maxHeight: "40%", overflowY: "auto" }}
    />
  );
}
