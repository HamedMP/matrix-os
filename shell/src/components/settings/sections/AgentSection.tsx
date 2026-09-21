"use client";

import { useMemo } from "react";
import { AgentsProvidersView, useProviderSettingsController } from "@matrix-os/ui";
import { getGatewayUrl } from "@/lib/gateway";
import { openProviderAuthorizationPath } from "@/lib/provider-browser-action";
import { createProviderSettingsTransport, openWebProviderAgentSetup } from "@/lib/provider-settings-transport";
import { currentAiCreditRuntimeSlot, openWebAiCreditCheckout } from "@/lib/ai-credit-checkout";

export function AgentSection({
  onOpenTerminal,
}: {
  onOpenTerminal?: (terminalSessionId: string) => void;
}) {
  const transport = useMemo(() => createProviderSettingsTransport(), []);
  const identityKey = getGatewayUrl();
  const controller = useProviderSettingsController({
    identityKey,
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
        onMutate={(intent) => controller.mutate(intent, {
          onLoginAction: (action) => {
            if (getGatewayUrl() !== identityKey) return;
            if (action.kind === "open_terminal") {
              if (!onOpenTerminal) throw new Error("Terminal unavailable");
              onOpenTerminal(action.terminalSessionId);
            } else if (action.kind === "open_browser") {
              if (!openProviderAuthorizationPath(action.authorizationPath)) throw new Error("Browser unavailable");
            }
          },
        })}
        onSetupHarness={onOpenTerminal ? (harness) => openWebProviderAgentSetup(harness, onOpenTerminal) : undefined}
        onOpenTerminal={(sessionId) => { onOpenTerminal?.(sessionId); }}
        onOpenBrowser={openProviderAuthorizationPath}
        onAddCredit={async (_sourceId, packageId, requestId) => {
          await openWebAiCreditCheckout({ packageId, requestId, runtimeSlot: currentAiCreditRuntimeSlot() });
        }}
      />
    </div>
  );
}
