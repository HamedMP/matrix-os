"use client";

import type { GetStartedAgentKind } from "@matrix-os/contracts";
import { GetStartedAgentLogin, useProviderSettingsController, type GetStartedAgentLoginPort } from "@matrix-os/ui";
import { useCallback, useMemo } from "react";
import { currentAiCreditRuntimeSlot } from "@/lib/ai-credit-checkout";
import { PROVIDER_SETTINGS_CHANGED_EVENT } from "@/lib/canonical-provider-setup";
import { getGatewayUrl } from "@/lib/gateway";
import { createProviderSettingsTransport } from "@/lib/provider-settings-transport";
import { createWebProviderWorkflowClient, openWebProviderWorkflowAuthorization } from "@/lib/provider-workflow-transport";

/** Web Desktop and Web Canvas: the Settings > Agents & providers sign-in for one agent, on step 3. */
export function ShellGetStartedAgentLogin({ agent }: { agent: GetStartedAgentKind }) {
  const transport = useMemo(() => createProviderSettingsTransport(), []);
  const identityKey = getGatewayUrl();
  const runtimeSlot = currentAiCreditRuntimeSlot();
  const isIdentityCurrent = useCallback(
    () => getGatewayUrl() === identityKey && currentAiCreditRuntimeSlot() === runtimeSlot,
    [identityKey, runtimeSlot],
  );
  const workflowClient = useMemo(() => createWebProviderWorkflowClient({ isIdentityCurrent }), [isIdentityCurrent]);
  // An agent signed in here is new to an already-open Chat too, as after a Settings sign-in.
  const onCatalogChanged = useCallback(() => {
    if (isIdentityCurrent()) window.dispatchEvent(new Event(PROVIDER_SETTINGS_CHANGED_EVENT));
  }, [isIdentityCurrent]);
  const controller = useProviderSettingsController({ identityKey: `${identityKey}:${runtimeSlot}`, transport, onCatalogChanged });
  const { snapshot, error, refresh } = controller;
  const port = useMemo<GetStartedAgentLoginPort>(() => ({
    snapshot,
    failed: snapshot === null && error !== null,
    workflowClient,
    refresh: () => refresh(),
    openAuthorizationUrl: (url) => {
      if (!isIdentityCurrent()) return;
      if (!openWebProviderWorkflowAuthorization(url)) throw new Error("Browser unavailable");
    },
  }), [snapshot, error, workflowClient, refresh, isIdentityCurrent]);
  return <GetStartedAgentLogin agent={agent} port={port} />;
}
