"use client";

import { useEffect, useMemo, useRef } from "react";
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
  const runtimeSlot = currentAiCreditRuntimeSlot();
  const checkoutLifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const lifetime = new AbortController();
    checkoutLifetime.current = lifetime;
    return () => {
      lifetime.abort();
      checkoutLifetime.current = null;
    };
  }, [identityKey, runtimeSlot]);
  const controller = useProviderSettingsController({
    identityKey,
    transport,
  });

  if (controller.snapshot === null) {
    const unavailable = controller.error !== null;
    return (
      <div className="px-5 py-6" data-provider-settings-adapter="shared">
        <div className="matrix-agents-providers" aria-busy={unavailable ? undefined : "true"}>
          <div className="matrix-ap-empty-state" role={unavailable ? "alert" : "status"}>
            <strong>{unavailable ? "Provider settings are unavailable" : "Loading agents & providers"}</strong>
            <span>{unavailable ? "Refresh Settings to try again." : "Checking this computer’s provider state…"}</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="px-5 py-6" data-provider-settings-adapter="shared">
      <AgentsProvidersView
        snapshot={controller.snapshot}
        selectedHarnessId={controller.selectedHarnessId}
        connectionAttempt={controller.connectionAttempt}
        busy={controller.busy}
        error={controller.error}
        onSelectHarness={controller.onSelectHarness}
        onRefresh={() => { void controller.refresh(); }}
        onRefreshForConnection={async () => {
          if (getGatewayUrl() !== identityKey) return null;
          const snapshot = await controller.refreshForConnection();
          return getGatewayUrl() === identityKey ? snapshot : null;
        }}
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
          const lifetime = checkoutLifetime.current;
          await openWebAiCreditCheckout({
            packageId, requestId, runtimeSlot,
            signal: lifetime?.signal,
            isIdentityCurrent: () => lifetime !== null && checkoutLifetime.current === lifetime
              && getGatewayUrl() === identityKey && currentAiCreditRuntimeSlot() === runtimeSlot,
          });
        }}
      />
    </div>
  );
}
