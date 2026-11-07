"use client";

import { useMemo } from "react";
import { GithubDeveloperAccessCard, type GithubDeveloperAccessClient } from "@matrix-os/ui";
import { getGatewayUrl } from "@/lib/gateway";
import { currentAiCreditRuntimeSlot } from "@/lib/ai-credit-checkout";
import { boundedProviderSettingsJson, createProviderSettingsTransport } from "@/lib/provider-settings-transport";

export function GithubDeveloperIntegration({
  active,
  onOpenGithubDeveloperTerminal,
}: {
  active: boolean;
  onOpenGithubDeveloperTerminal?: () => void;
}) {
  const identityKey = getGatewayUrl();
  const runtimeSlot = currentAiCreditRuntimeSlot();
  const transport = useMemo(() => createProviderSettingsTransport(), []);
  const githubDeveloperAccessClient = useMemo<GithubDeveloperAccessClient>(() => ({
    async status(signal) {
      const timeout = AbortSignal.timeout(10_000);
      const response = await fetch(`${identityKey}/api/github/status`, {
        cache: "no-store",
        signal: AbortSignal.any([signal, timeout]),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("GitHub developer access is unavailable.");
      }
      const value = await boundedProviderSettingsJson(response, 16 * 1024);
      if (getGatewayUrl() !== identityKey || currentAiCreditRuntimeSlot() !== runtimeSlot) {
        throw new Error("GitHub developer access is unavailable.");
      }
      return value;
    },
    async setupAccess(signal) {
      const { access } = await transport.getSnapshot(signal);
      if (getGatewayUrl() !== identityKey || currentAiCreditRuntimeSlot() !== runtimeSlot) {
        throw new Error("GitHub developer access is unavailable.");
      }
      return onOpenGithubDeveloperTerminal ? access : { mode: "read_only", reason: "insufficient_permission" };
    },
    async startSetup() {
      if (!onOpenGithubDeveloperTerminal
        || getGatewayUrl() !== identityKey
        || currentAiCreditRuntimeSlot() !== runtimeSlot) return false;
      onOpenGithubDeveloperTerminal();
      return true;
    },
  }), [identityKey, onOpenGithubDeveloperTerminal, runtimeSlot, transport]);
  return <GithubDeveloperAccessCard identityKey={`${identityKey}:${runtimeSlot}`} client={githubDeveloperAccessClient} active={active} />;
}
