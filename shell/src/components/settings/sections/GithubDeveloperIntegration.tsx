"use client";

import { useMemo, type ReactNode } from "react";
import { githubDeveloperDisconnectCommand, GithubDeveloperAccess, type GithubDeveloperAccessClient, type IntegrationRowPresentation } from "@matrix-os/ui";
import { getGatewayUrl } from "@/lib/gateway";
import { currentAiCreditRuntimeSlot } from "@/lib/ai-credit-checkout";
import { boundedProviderSettingsJson, createProviderSettingsTransport, openWebProviderTerminalCommand } from "@/lib/provider-settings-transport";

export function GithubDeveloperIntegration({
  active,
  onOpenGithubDeveloperTerminal,
  onOpenGithubDisconnectTerminal,
  children,
}: {
  active: boolean;
  onOpenGithubDeveloperTerminal?: () => void;
  onOpenGithubDisconnectTerminal?: (sessionId: string) => void;
  children: (presentation: IntegrationRowPresentation) => ReactNode;
}) {
  const identityKey = getGatewayUrl();
  const runtimeSlot = currentAiCreditRuntimeSlot();
  const transport = useMemo(() => createProviderSettingsTransport(), []);
  const githubDeveloperAccessClient = useMemo<GithubDeveloperAccessClient>(() => {
    const isIdentityCurrent = () => getGatewayUrl() === identityKey && currentAiCreditRuntimeSlot() === runtimeSlot;
    return {
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
        if (!isIdentityCurrent()) throw new Error("GitHub developer access is unavailable.");
        return value;
      },
      async setupAccess(signal) {
        const { access } = await transport.getSnapshot(signal);
        if (!isIdentityCurrent()) throw new Error("GitHub developer access is unavailable.");
        return onOpenGithubDeveloperTerminal || onOpenGithubDisconnectTerminal
          ? access : { mode: "read_only", reason: "insufficient_permission" };
      },
      async startSetup() {
        if (!onOpenGithubDeveloperTerminal || !isIdentityCurrent()) return false;
        onOpenGithubDeveloperTerminal();
        return true;
      },
      ...(onOpenGithubDisconnectTerminal ? {
        async startDisconnect(account: string, signal: AbortSignal) {
          const command = githubDeveloperDisconnectCommand(account);
          if (!command) return false;
          return openWebProviderTerminalCommand(command, `disconnect-github-${crypto.randomUUID().slice(0, 8)}`,
            onOpenGithubDisconnectTerminal, isIdentityCurrent, signal);
        },
      } : {}),
    };
  }, [identityKey, onOpenGithubDeveloperTerminal, onOpenGithubDisconnectTerminal, runtimeSlot, transport]);
  return <GithubDeveloperAccess identityKey={`${identityKey}:${runtimeSlot}`} client={githubDeveloperAccessClient} active={active}>{children}</GithubDeveloperAccess>;
}
