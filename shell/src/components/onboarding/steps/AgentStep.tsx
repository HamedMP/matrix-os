"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { palette as c, fonts, radii, StatusPill } from "@matrix-os/brand";
import { getGatewayUrl } from "@/lib/gateway";
import { createTerminalLaunchPath } from "@/lib/terminal-launch";

interface AgentRow {
  id: "claude" | "codex" | "hermes";
  label: string;
  loginAction: "claude-login" | "codex-login" | null;
}

const AGENT_ROWS: AgentRow[] = [
  { id: "claude", label: "Claude Code", loginAction: "claude-login" },
  { id: "codex", label: "Codex", loginAction: "codex-login" },
  { id: "hermes", label: "Hermes", loginAction: null },
];

interface AgentAvailability {
  id: string;
  available: boolean;
}

const dotStyle = {
  width: 8,
  height: 8,
  borderRadius: "50%",
  background: c.forest,
  flexShrink: 0,
} as const;

const headerStyle = {
  display: "flex",
  alignItems: "center",
  gap: 8,
} as const;

const connectButtonStyle = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "4px 12px",
  borderRadius: radii.control,
  border: `1px solid ${c.border}`,
  background: "transparent",
  color: c.deep,
  fontSize: 12,
  fontFamily: fonts.sans,
  fontWeight: 500,
  cursor: "pointer",
  lineHeight: 1.5,
} as const;

export function AgentStep({
  title,
  status,
  expanded,
  onOpenTerminal,
  onChange,
}: {
  title: string;
  status?: "done" | "active" | "pending";
  expanded?: boolean;
  onOpenTerminal?: (path: string) => void;
  onChange?: () => void;
}) {
  const mountedRef = useRef(false);
  const [agents, setAgents] = useState<AgentAvailability[]>([]);

  const fetchStatus = useCallback(() => {
    void fetch(`${getGatewayUrl()}/api/agents/credentials/status`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    })
      .then(async (res) => {
        if (!res.ok) return;
        const body = (await res.json()) as { agents?: AgentAvailability[] };
        if (mountedRef.current) setAgents(body.agents ?? []);
      })
      .catch((err: unknown) => {
        console.warn("[AgentStep] status fetch failed:", err instanceof Error ? err.name : typeof err);
      });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    fetchStatus();
    return () => {
      mountedRef.current = false;
    };
  }, [fetchStatus]);

  function isAvailable(id: string): boolean {
    const found = agents.find((a) => a.id === id);
    return found?.available === true;
  }

  const statusPillTone = status === "done" ? "connected" : status === "active" ? "pending" : "pending";

  return (
    <div
      style={{
        border: `1px solid ${c.border}`,
        borderRadius: 11,
        background: c.card,
        overflow: "hidden",
      }}
    >
      <div style={{ padding: "10px 12px" }}>
        <div style={headerStyle}>
          <span style={dotStyle} aria-hidden="true" />
          <span style={{ flex: 1, fontSize: 13, fontFamily: fonts.sans, fontWeight: 500, color: c.deep }}>{title}</span>
          {status === "done" ? (
            <StatusPill tone="connected">Connected</StatusPill>
          ) : status === "active" ? (
            <StatusPill tone="pending">Action needed</StatusPill>
          ) : null}
        </div>
        {expanded ? (
          <p style={{ margin: "4px 0 0 16px", fontSize: 12, color: c.subtle, fontFamily: fonts.sans }}>
            Connect a coding agent to run commands, write code, and run tests.
          </p>
        ) : null}
      </div>

      {expanded ? (
        <div style={{ borderTop: `1px solid ${c.border}`, display: "flex", flexDirection: "column", gap: 0 }}>
          {AGENT_ROWS.map((row, idx) => {
            const available = row.id === "hermes" ? true : isAvailable(row.id);
            return (
              <div
                key={row.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "8px 12px",
                  borderTop: idx === 0 ? undefined : `1px solid ${c.border}`,
                  gap: 8,
                }}
              >
                <span style={{ fontSize: 13, fontFamily: fonts.sans, color: c.deep, fontWeight: 400 }}>
                  {row.label}
                </span>
                {available ? (
                  <StatusPill tone={row.id === "hermes" ? "ready" : "connected"}>
                    {row.id === "hermes" ? "Ready" : "Connected"}
                  </StatusPill>
                ) : row.loginAction ? (
                  <button
                    type="button"
                    role="button"
                    style={connectButtonStyle}
                    onClick={() => {
                      if (row.loginAction) {
                        onOpenTerminal?.(createTerminalLaunchPath(row.loginAction));
                        onChange?.();
                      }
                    }}
                  >
                    Connect
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
