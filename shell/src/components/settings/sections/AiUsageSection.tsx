"use client";
import React, { useCallback } from "react";
import { useUser } from "@clerk/nextjs";
import { AutomaticAiUsagePanel } from "@matrix-os/ui/ai-usage-auto";
import { loadMatrixUsage } from "@matrix-os/ui/ai-usage-load";
import { getGatewayUrl } from "@/lib/gateway";
import { isSelfHostedRuntime } from "@/lib/self-host-mode";
class UsageRequestError extends Error {
  constructor(readonly status: number) {
    super("Usage unavailable");
    this.name = "UsageRequestError";
  }
}
export function AiUsageSection() {
  // Self-hosted documents render without ClerkProvider, so useUser must never run there.
  // react-doctor-disable-next-line react-doctor/no-hydration-branch-on-browser-global -- both sides read the same MATRIX_SELF_HOSTED flag, as in ShellGetStartedGate
  if (isSelfHostedRuntime()) return <UsageSection owner={null} />;
  return <ClerkUsageSection />;
}
function ClerkUsageSection() {
  const { user, isLoaded } = useUser();
  // Loading before the owner is known would show an error, then load again once Clerk resolves.
  if (!isLoaded) return null;
  return <UsageSection owner={user?.id ?? null} />;
}
/** Same resolution as Electron Desktop: live index first, owner-bound export on computers without one. */
function UsageSection({ owner }: { owner: string | null }) {
  const base = getGatewayUrl();
  const load = useCallback(
    async (signal: AbortSignal) => {
      const result = await loadMatrixUsage(
        {
          async get(path, signal) {
            const response = await fetch(`${base}${path}`, {
              credentials: "include",
              cache: "no-store",
              signal: AbortSignal.any([signal, AbortSignal.timeout(65_000)]),
            });
            if (!response.ok) throw new UsageRequestError(response.status);
            return response.json();
          },
          status: (error) =>
            error instanceof UsageRequestError ? error.status : undefined,
        },
        owner,
        signal,
        { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      );
      return result.snapshot;
    },
    [base, owner],
  );
  return (
    <AutomaticAiUsagePanel
      key={`${base}:${owner}`}
      load={load}
      sourceLabel="your Matrix computer"
    />
  );
}
