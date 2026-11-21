import { useMemo } from "react";
import { HerdrSessionsGroup, useHerdrSessions } from "@matrix-os/ui/herdr-sessions";

import type { ApiClient } from "../../lib/api";
import type { ShellSessionSummary } from "../../stores/shell-sessions";
import { herdrDesktopSession, herdrSessionsRequest } from "./herdr-desktop-session";

/** "Herdr sessions" after the Matrix sessions in the Electron Desktop Terminal (spec 2701). */
export function DesktopHerdrSessions({ api, selectedName, onOpen }: {
  api: ApiClient | null;
  selectedName: string | null;
  onOpen(shell: ShellSessionSummary): void;
}) {
  const request = useMemo(() => (api ? herdrSessionsRequest(api) : null), [api]);
  const herdr = useHerdrSessions({ request });
  return (
    <HerdrSessionsGroup
      list={herdr.list}
      selectedRefKey={selectedName}
      closingIds={herdr.closingIds}
      error={herdr.error}
      onOpen={(session) => onOpen(herdrDesktopSession(session))}
      onClose={(session) => herdr.close(session.id)}
      style={{ color: "var(--text-primary)", maxHeight: "40%", overflowY: "auto" }}
    />
  );
}
