"use client";

/**
 * Owner approvals for external Matrix Core MCP writes (spec 2691, layer 7),
 * shared by Web Canvas, Web Desktop, and Electron Desktop.
 *
 * Contract (`/api/mcp-servers/core/external-approvals`): each pending entry
 * carries approval id, service, tool, and request/expiry times only. Tool
 * arguments and the client name are deliberately not exposed, so the owner
 * reviews which tool on which service is asking, never upstream payloads.
 */
import { ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../Button.js";
import { McpServiceLogo } from "./McpServiceLogo.js";
import { MCP_SERVICE_MARKS } from "./mcp-service-marks.js";
import { mcpTokens } from "./mcp-settings-tokens.js";
import {
  EXTERNAL_MCP_APPROVALS_DEFAULT_POLL_MS,
  EXTERNAL_MCP_APPROVALS_LOAD_ERROR,
  EXTERNAL_MCP_APPROVALS_MIN_POLL_MS,
  ExternalMcpApprovalListSchema,
  ExternalMcpDecisionResultSchema,
  externalMcpApprovalErrorMessage,
  type ExternalMcpApproval,
  type ExternalMcpApprovalsTransport,
  type ExternalMcpDecision,
} from "./external-mcp-approvals-client.js";

const muted = { color: mcpTokens.muted };
const t = mcpTokens;

type ListState = { status: "loading" | "failed"; approvals: [] } | { status: "loaded"; approvals: ExternalMcpApproval[] };

/** Bounded polling (>= 15 s) that pauses while the document is hidden and refreshes when it returns. */
export function useExternalMcpApprovals(transport: ExternalMcpApprovalsTransport | null, pollMs = EXTERNAL_MCP_APPROVALS_DEFAULT_POLL_MS) {
  const [state, setState] = useState<ListState>({ status: "loading", approvals: [] });
  const latest = useRef(0);
  const load = useCallback(async () => {
    if (!transport) return;
    const request = ++latest.current;
    try {
      const parsed = ExternalMcpApprovalListSchema.parse(await transport.list());
      if (request === latest.current) setState({ status: "loaded", approvals: parsed.approvals });
    } catch (error: unknown) {
      console.warn("[external-mcp-approvals] list unavailable", error instanceof Error ? error.name : "UnknownError");
      if (request === latest.current) setState({ status: "failed", approvals: [] });
    }
  }, [transport]);

  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- polling is the read boundary until a realtime approval channel exists; stale responses are discarded by request id.
  useEffect(() => {
    if (!transport) return;
    const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";
    void load();
    const timer = setInterval(() => { if (!hidden()) void load(); }, Math.max(pollMs, EXTERNAL_MCP_APPROVALS_MIN_POLL_MS));
    const onVisibility = () => { if (!hidden()) void load(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      latest.current += 1;
    };
  }, [load, pollMs, transport]);

  return { state: transport ? state : { status: "failed" as const, approvals: [] as [] }, reload: load };
}

function minutes(ms: number): number {
  return Math.max(1, Math.round(Math.abs(ms) / 60_000));
}

/** Approvals name a server like "linear-1a2b3c4d"; its prefix picks the catalog logo when one exists. */
function presetIdForService(service: string | null | undefined): string | undefined {
  const prefix = service?.toLowerCase().split(/[-\s]/)[0];
  return prefix && Object.hasOwn(MCP_SERVICE_MARKS, prefix) ? prefix : undefined;
}

function ApprovalRow({ approval, busy, onDecide }: { approval: ExternalMcpApproval; busy: boolean; onDecide: (decision: ExternalMcpDecision) => void }) {
  const service = approval.service ?? "Unknown service";
  const remaining = Date.parse(approval.expiresAt) - Date.now();
  const expired = remaining <= 0;
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-2xl border px-4 py-3" style={{ borderColor: t.border, background: t.surface }}>
      <McpServiceLogo presetId={presetIdForService(approval.service)} name={service} size={36} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium" style={{ color: t.text }}>
          <code className="rounded-md px-1.5 py-0.5 text-xs" style={{ fontFamily: t.mono, background: t.sunken }}>{approval.tool}</code> <span style={muted}>· {service}</span>
        </p>
        <p className="mt-0.5 text-xs" style={muted}>
          External MCP client · Requested {minutes(Date.now() - Date.parse(approval.createdAt))} min ago · {expired ? "Expired" : `Expires in ${minutes(remaining)} min`}
        </p>
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="secondary" disabled={busy || expired} aria-label={`Decline ${approval.tool} on ${service}`} onClick={() => onDecide("decline")}>Decline</Button>
        <Button size="sm" disabled={busy || expired} aria-label={`Approve ${approval.tool} on ${service}`} onClick={() => onDecide("approve")}>Approve</Button>
      </div>
    </li>
  );
}

/** Onboarding empty state: how an external client reaches this screen, plus a manual re-check. */
function EmptyState({ onCheck }: { onCheck: () => void }) {
  return (
    <div data-empty-state className="flex flex-col items-center rounded-2xl border border-dashed px-6 py-7 text-center" style={{ borderColor: t.border }}>
      <span aria-hidden="true" className="flex size-10 items-center justify-center rounded-xl" style={{ background: t.sunken, color: t.muted }}><ShieldCheck className="size-5" /></span>
      <p className="mt-3 text-sm font-medium" style={{ color: t.text }}>No external writes are waiting</p>
      <p className="mt-1 max-w-md text-xs" style={muted}>
        When Claude Code, Codex, or another MCP client connected to Matrix asks to run a write tool, it waits here for you.
        Connect a client with <code style={{ fontFamily: t.mono }}>matrix mcp login</code>, or bridge a stdio-only client with <code style={{ fontFamily: t.mono }}>matrix mcp bridge</code>.
      </p>
      <Button className="mt-3" size="sm" variant="secondary" onClick={onCheck}>Check again</Button>
    </div>
  );
}

/** Settings → Integrations: pending external writes with Approve and Decline. */
export function ExternalMcpApprovalsPanel({ transport }: { transport: ExternalMcpApprovalsTransport | null }) {
  const { state, reload } = useExternalMcpApprovals(transport);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decide = async (approvalId: string, decision: ExternalMcpDecision) => {
    if (!transport) return;
    setBusyId(approvalId);
    setError(null);
    try {
      ExternalMcpDecisionResultSchema.parse(await transport.decide(approvalId, decision));
      await reload();
    } catch (failure: unknown) {
      console.warn("[external-mcp-approvals] decision failed", failure instanceof Error ? failure.name : "UnknownError");
      setError(externalMcpApprovalErrorMessage(failure));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section aria-label="External MCP approvals" className="space-y-3">
      <div className="space-y-0.5">
        <h4 className="flex flex-wrap items-center gap-2 text-base font-semibold tracking-tight" style={{ color: t.text }}>
          External write approvals
          {state.status === "loaded" && state.approvals.length > 0 ? (
            <span className="rounded-full px-2 py-0.5 text-[11px] font-medium" style={{ background: `color-mix(in srgb, ${t.warning} 16%, transparent)`, color: t.text }}>{state.approvals.length} waiting</span>
          ) : null}
        </h4>
        <p className="text-sm" style={{ color: t.secondary }}>Writes from MCP clients outside Matrix wait here for you. Matrix never shows their arguments; approve only tools you expect a client to use.</p>
      </div>
      {error ? <div role="alert" className="rounded-xl border px-3 py-2 text-sm" style={{ borderColor: "var(--danger, var(--destructive))", color: "var(--danger, var(--destructive))" }}>{error}</div> : null}
      {state.status === "loading" ? <p role="status" className="text-sm" style={muted}>Loading approvals…</p> : null}
      {state.status === "failed" ? <div role="alert" className="rounded-2xl border p-4 text-sm" style={{ borderColor: t.border, background: t.surface }}>{EXTERNAL_MCP_APPROVALS_LOAD_ERROR}
        {transport ? <div className="mt-2"><Button size="sm" variant="secondary" onClick={() => { void reload(); }}>Try again</Button></div> : null}</div> : null}
      {state.status === "loaded" && state.approvals.length === 0 ? <EmptyState onCheck={() => { void reload(); }} /> : null}
      {state.status === "loaded" && state.approvals.length > 0 ? <ul aria-label="Pending external MCP approvals" className="space-y-2">
        {state.approvals.map(approval => <ApprovalRow key={approval.approvalId} approval={approval} busy={busyId !== null}
          onDecide={(decision) => { void decide(approval.approvalId, decision); }} />)}
      </ul> : null}
    </section>
  );
}

/** Notification-host pill: rendered only while approvals are pending. */
export function ExternalMcpApprovalsIndicator({ transport, onOpen, pollMs }: { transport: ExternalMcpApprovalsTransport | null; onOpen: () => void; pollMs?: number }) {
  const { state } = useExternalMcpApprovals(transport, pollMs);
  const count = state.status === "loaded" ? state.approvals.length : 0;
  if (count === 0) return null;
  const label = `${count} external MCP ${count === 1 ? "write" : "writes"} waiting for approval`;
  return (
    <button type="button" onClick={onOpen} aria-label={label}
      className="pointer-events-auto rounded-full border border-border/60 bg-card px-3 py-1.5 text-xs font-medium shadow-sm">
      {label}
    </button>
  );
}
