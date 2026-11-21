"use client";

import { HerdrSessionsGroup, useHerdrSessions } from "@matrix-os/ui/herdr-sessions";
import { herdrShellSession, shellHerdrRequest } from "./herdr-shell-session";
import type { ShellSessionSummary } from "./terminal-session-state";

/** The owner's Herdr sessions over the shell's gateway transport. */
export function useShellHerdrSessions() {
  return useHerdrSessions({ request: shellHerdrRequest });
}

export type ShellHerdrSessionsState = ReturnType<typeof useShellHerdrSessions>;

/** "Herdr sessions" after the project workspaces, on Web Desktop and Web Canvas (spec 2701). */
export function ShellHerdrSessions({ herdr, selectedSessionId, onOpen }: {
  herdr: ShellHerdrSessionsState;
  selectedSessionId: string | null;
  onOpen(shell: ShellSessionSummary): void;
}) {
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
