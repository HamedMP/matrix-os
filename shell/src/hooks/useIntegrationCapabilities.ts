"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface IntegrationCapabilitySummary {
  id: string;
  provider: "github" | "calendar" | "email" | "messaging" | "publishing";
  capability: string;
  status: "connect_required" | "connected" | "approved" | "revoked" | "failed" | "unavailable";
  approvedAgents: Array<"claude" | "codex" | "hermes">;
  requiresApprovalPerAction: boolean;
}

export function useIntegrationCapabilities() {
  const mountedRef = useRef(false);
  const [capabilities, setCapabilities] = useState<IntegrationCapabilitySummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void fetch("/api/integrations/capabilities", {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error("integration capabilities request failed");
        return await res.json() as { capabilities: IntegrationCapabilitySummary[] };
      })
      .then((body) => {
        if (!mountedRef.current) return;
        setCapabilities(body.capabilities);
        setError(null);
      })
      .catch((err: unknown) => {
        console.warn("[onboarding] integration capabilities failed:", err instanceof Error ? err.message : String(err));
        if (mountedRef.current) setError("Could not load integration capabilities");
      });
  }, []);

  const approveForHermes = useCallback((capabilityId: string) => {
    void fetch(`/api/integrations/capabilities/${encodeURIComponent(capabilityId)}/approval`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ agent: "hermes", approved: true }),
      signal: AbortSignal.timeout(10_000),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error("integration capability approval failed");
        return await res.json();
      })
      .then(() => {
        if (!mountedRef.current) return;
        refresh();
      })
      .catch((err: unknown) => {
        console.warn("[onboarding] integration approval failed:", err instanceof Error ? err.message : String(err));
        if (mountedRef.current) setError("Could not approve capability");
      });
  }, [refresh]);

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  return { capabilities, error, refresh, approveForHermes };
}
