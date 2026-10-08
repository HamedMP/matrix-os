import type { CollaborationApi } from "./ChatCollaboratorsDialog.js";
import { LegacyLiveAccessButton } from "./LegacyLiveAccessButton.js";

export function LegacyTerminalAccessButton({ api, runtimeId, organizationId, terminalId }: {
  api: CollaborationApi;
  runtimeId: string | null;
  organizationId: string | null;
  terminalId: string;
}) {
  return <LegacyLiveAccessButton api={api} runtimeId={runtimeId} organizationId={organizationId}
    kind="terminal" resourceId={terminalId} resourceLabel="terminal" />;
}
