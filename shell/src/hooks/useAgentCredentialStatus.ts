"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type AgentId = "claude" | "codex" | "hermes";

export interface AgentCredentialSummary {
  agent: AgentId;
  status: "available" | "missing" | "auth_required" | "check_failed" | "version_unsupported" | "expired" | "revoked" | "failed" | "not_applicable";
  coordinationRole: "system_agent" | "core_agent" | "coding_specialist" | "assistant_specialist";
  workflows: string[];
  degradedWorkflows: string[];
  verifiedAt: string | null;
  nextAction: string | null;
}

export interface AgentCredentialStatus {
  systemAgent: "hermes";
  activeAgents: AgentId[];
  agents: AgentCredentialSummary[];
  routingExplanation: string;
}

export function useAgentCredentialStatus() {
  const mountedRef = useRef(false);
  const [status, setStatus] = useState<AgentCredentialStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- returned hook API / stable identity for effect dep
  const refresh = useCallback(() => {
    void fetch("/api/agents/credentials/status", {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error("credential status request failed");
        return await res.json() as AgentCredentialStatus;
      })
      .then((body) => {
        if (!mountedRef.current) return;
        setStatus(body);
        setError(null);
      })
      .catch((err: unknown) => {
        console.warn("[onboarding] agent credential status failed:", err instanceof Error ? err.message : String(err));
        if (mountedRef.current) setError("Could not load agent setup");
      });
  }, []);

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- returned hook API / stable identity for effect dep
  const verify = useCallback((agent: Exclude<AgentId, "hermes">) => {
    void fetch(`/api/agents/credentials/${agent}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(10_000),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error("credential verification failed");
        return await res.json();
      })
      .then(() => {
        if (!mountedRef.current) return;
        refresh();
      })
      .catch((err: unknown) => {
        console.warn("[onboarding] agent credential verification failed:", err instanceof Error ? err.message : String(err));
        if (mountedRef.current) setError("Could not verify agent credential");
      });
  }, [refresh]);

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  return { status, error, refresh, verify };
}
