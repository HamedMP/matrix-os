"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getGatewayUrl } from "@/lib/gateway";
import {
  TERMINAL_AGENT_OPTIONS,
  parseTerminalAgentStatuses,
  type TerminalAgentId,
  type TerminalAgentInstallState,
} from "./terminal-agent-options";

const AGENT_STATUS_TIMEOUT_MS = 10_000;
const UNKNOWN_AGENT_STATUSES: Record<TerminalAgentId, TerminalAgentInstallState> = {
  claude: "unknown",
  codex: "unknown",
  opencode: "unknown",
  pi: "unknown",
};

export interface TerminalAgentStatusesState {
  statuses: Record<TerminalAgentId, TerminalAgentInstallState>;
  checking: boolean;
  statusUnavailable: boolean;
  refresh: () => void;
}

export function useTerminalAgentStatuses(): TerminalAgentStatusesState {
  const [statuses, setStatuses] = useState(UNKNOWN_AGENT_STATUSES);
  const [checking, setChecking] = useState(true);
  const [statusUnavailable, setStatusUnavailable] = useState(false);
  const requestSequenceRef = useRef(0);
  const requestControllerRef = useRef<AbortController | null>(null);

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- shared hook API requires stable refresh identity for mount and menu-open refreshes.
  const refresh = useCallback(() => {
    const requestSequence = requestSequenceRef.current + 1;
    requestSequenceRef.current = requestSequence;
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    setChecking(true);
    setStatusUnavailable(false);

    void fetch(`${getGatewayUrl()}/api/agents`, {
      signal: AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(AGENT_STATUS_TIMEOUT_MS),
      ]),
    }).then(async (response) => {
      if (!response.ok) throw new Error("agent status request failed");
      const parsed = parseTerminalAgentStatuses(await response.json());
      const complete = TERMINAL_AGENT_OPTIONS.every((option) => (
        parsed.some((status) => status.id === option.id)
      ));
      if (!complete) throw new Error("agent status response incomplete");
      if (requestSequenceRef.current !== requestSequence) return;
      setStatuses(Object.fromEntries(
        parsed.map((status) => [status.id, status.installState]),
      ) as Record<TerminalAgentId, TerminalAgentInstallState>);
      setStatusUnavailable(parsed.some((status) => status.installState === "unknown"));
    }).catch((err: unknown) => {
      if (requestSequenceRef.current !== requestSequence) return;
      console.warn("Failed to load terminal agent status:", err instanceof Error ? err.message : String(err));
      setStatusUnavailable(true);
    }).finally(() => {
      if (requestSequenceRef.current !== requestSequence) return;
      setChecking(false);
    });
  }, []);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) refresh();
    });
    return () => {
      active = false;
      requestSequenceRef.current += 1;
      requestControllerRef.current?.abort();
    };
  }, [refresh]);

  return { statuses, checking, statusUnavailable, refresh };
}
