"use client";

import { useMemo, type ReactNode } from "react";
import { GITHUB_DEVELOPER_DEVICE_URL, githubDeveloperDisconnectCommand, GithubDeveloperAccess, type GithubDeveloperAccessClient, type IntegrationRowPresentation } from "@matrix-os/ui";
import { getGatewayUrl } from "@/lib/gateway";
import { currentAiCreditRuntimeSlot } from "@/lib/ai-credit-checkout";
import { boundedProviderSettingsJson, createProviderSettingsTransport, openWebProviderTerminalCommand } from "@/lib/provider-settings-transport";

export function GithubDeveloperIntegration({
  active,
  onOpenGithubDisconnectTerminal,
  children,
}: {
  active: boolean;
  onOpenGithubDisconnectTerminal?: (sessionId: string) => void;
  children: (presentation: IntegrationRowPresentation) => ReactNode;
}) {
  const identityKey = getGatewayUrl();
  const runtimeSlot = currentAiCreditRuntimeSlot();
  const transport = useMemo(() => createProviderSettingsTransport(), []);
  const githubDeveloperAccessClient = useMemo<GithubDeveloperAccessClient>(() => {
    const isIdentityCurrent = () => getGatewayUrl() === identityKey && currentAiCreditRuntimeSlot() === runtimeSlot;
    async function request(path: string, signal: AbortSignal, method = "GET") {
      const response = await fetch(`${identityKey}/api/github/${path}`, {
        method,
        cache: "no-store",
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        ...(method === "POST" ? { headers: { "Content-Type": "application/json" }, body: "{}" } : {}),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("GitHub developer access is unavailable.");
      }
      return boundedProviderSettingsJson(response, 16 * 1024);
    }
    async function requestCurrent(path: string, signal: AbortSignal, method = "GET") {
      if (!isIdentityCurrent()) throw new Error("GitHub developer access is unavailable.");
      const value = await request(path, signal, method);
      if (!isIdentityCurrent()) throw new Error("GitHub developer access is unavailable.");
      return value;
    }
    return {
      status: (signal) => requestCurrent("status", signal),
      async setupAccess(signal) {
        if (!isIdentityCurrent()) throw new Error("GitHub developer access is unavailable.");
        const { access } = await transport.getSnapshot(signal);
        if (!isIdentityCurrent()) throw new Error("GitHub developer access is unavailable.");
        return access;
      },
      startSetup: (signal) => requestCurrent("setup", signal, "POST"),
      getSetup: (id, signal) => requestCurrent(`setup/${encodeURIComponent(id)}`, signal),
      cancelSetup(id, signal) {
        // Explicit VM URLs keep their target after navigation. The root gateway
        // uses a routing cookie and can refer to a different Computer by then.
        if (!isIdentityCurrent() && !identityKey.startsWith(`${window.location.origin}/vm/`)) return Promise.resolve();
        return request(`setup/${encodeURIComponent(id)}/cancel`, signal, "POST");
      },
      openSetupPage() {
        if (!isIdentityCurrent()) throw new Error("GitHub developer access is unavailable.");
        window.open(GITHUB_DEVELOPER_DEVICE_URL, "_blank", "noopener,noreferrer");
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
  }, [identityKey, onOpenGithubDisconnectTerminal, runtimeSlot, transport]);
  return <GithubDeveloperAccess identityKey={`${identityKey}:${runtimeSlot}`} client={githubDeveloperAccessClient} active={active}>{children}</GithubDeveloperAccess>;
}
