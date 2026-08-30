"use client";

import { useMemo } from "react";
import { AgentsProvidersView, useProviderSettingsController } from "@matrix-os/ui";
import { getGatewayUrl } from "@/lib/gateway";
import { openProviderAuthorizationPath } from "@/lib/provider-browser-action";
import { createProviderSettingsTransport } from "@/lib/provider-settings-transport";

export function AgentSection({
  onOpenTerminal,
}: {
  onOpenTerminal?: (terminalSessionId: string) => void;
}) {
  const transport = useMemo(() => createProviderSettingsTransport(), []);
  const controller = useProviderSettingsController({
    identityKey: getGatewayUrl(),
    transport,
  });

  if (controller.snapshot === null) {
    const unavailable = controller.error !== null;
    return (
      <div className="matrix-agents-providers" aria-busy={unavailable ? undefined : "true"} data-provider-settings-adapter="shared">
        <div className="matrix-ap-empty-state" role={unavailable ? "alert" : "status"}>
          <strong>{unavailable ? "Provider settings are unavailable" : "Loading agents & providers"}</strong>
          <span>{unavailable ? "Refresh Settings to try again." : "Checking this computer’s provider state…"}</span>
        </div>
      </div>
    );
  }

  return (
    <div data-provider-settings-adapter="shared">
      <AgentsProvidersView
        snapshot={controller.snapshot}
        selectedHarnessId={controller.selectedHarnessId}
        connectionAttempt={controller.connectionAttempt}
        busy={controller.busy}
        error={controller.error}
        onSelectHarness={controller.onSelectHarness}
        onRefresh={() => { void controller.refresh(); }}
        onMutate={(intent) => { void controller.mutate(intent); }}
        onOpenTerminal={(sessionId) => { onOpenTerminal?.(sessionId); }}
        onOpenBrowser={openProviderAuthorizationPath}
        onAddCredit={() => undefined}
      />
    </div>
  );
}
