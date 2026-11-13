"use client";

import { ArrowRight, Check, Copy, Waypoints } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { McpServiceLogo, McpServiceLogoStack } from "./McpServiceLogo.js";
import { matrixMcpClientSetups, type MatrixMcpClientId } from "./matrix-mcp-endpoint.js";
import { mcpTokens as t } from "./mcp-settings-tokens.js";

export interface MatrixMcpEndpointCardProps {
  /** The hosted Matrix MCP URL (see `matrixMcpEndpointUrl`). */
  endpointUrl: string;
  /** Services that are connected and ready; shown as the "routes to" side of the card. */
  connectedServices: ReadonlyArray<{ presetId?: string; name: string }>;
}

const COPY_RESET_MS = 1800;

/** Copies text and reports the outcome; clipboard access can be denied in sandboxed or unfocused windows. */
function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = async (key: string, text: string) => {
    if (timer.current) clearTimeout(timer.current);
    try {
      if (!navigator.clipboard) throw new Error("ClipboardUnavailable");
      await navigator.clipboard.writeText(text);
      setFailed(null);
      setCopied(key);
    } catch (error: unknown) {
      console.warn("[matrix-mcp] copy failed:", error instanceof Error ? error.name : "UnknownError");
      setCopied(null);
      setFailed(key);
    }
    timer.current = setTimeout(() => { setCopied(null); setFailed(null); }, COPY_RESET_MS);
  };
  return { copied, failed, copy };
}

function CopyButton({ label, done, failed, onClick, compact = false }: { label: string; done: boolean; failed: boolean; onClick: () => void; compact?: boolean }) {
  return (
    <button type="button" aria-label={label} onClick={onClick}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg text-xs font-medium transition-colors focus-visible:outline-2 ${compact ? "px-2 py-1" : "px-3 py-2"}`}
      style={{ background: done ? t.success : t.primary, color: t.primaryFg }}>
      {done ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      <span aria-live="polite">{done ? "Copied" : failed ? "Copy failed" : "Copy"}</span>
    </button>
  );
}

const CLIENT_CHIPS = ["Claude Code", "Codex", "Cursor"] as const;

/**
 * The hero of Settings → MCPs: one Matrix MCP URL that routes to every service
 * the owner connected, plus copy-paste setup for common clients (spec 2691).
 */
export function MatrixMcpEndpointCard({ endpointUrl, connectedServices }: MatrixMcpEndpointCardProps) {
  const setups = matrixMcpClientSetups(endpointUrl);
  const [client, setClient] = useState<MatrixMcpClientId>("claude-code");
  const active = setups.find(setup => setup.id === client) ?? setups[0]!;
  const { copied, failed, copy } = useCopy();
  const count = connectedServices.length;

  return (
    <section aria-label="Your Matrix MCP" className="overflow-hidden rounded-2xl border"
      style={{ borderColor: t.border, background: t.surface }}>
      <div className="relative space-y-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-xl"
              style={{ background: t.primary, color: t.primaryFg }}>
              <Waypoints size={20} />
            </span>
            <div className="min-w-0">
              <h4 className="text-base font-semibold tracking-tight" style={{ color: t.text }}>Your Matrix MCP</h4>
              <p className="mt-0.5 max-w-xl text-sm" style={{ color: t.secondary }}>
                One URL for every service you connect here. Add it to Claude Code, Codex, or any MCP client and sign in to Matrix once; you never set up each service again.
              </p>
            </div>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
            style={{ background: t.sunken, color: count > 0 ? t.text : t.muted }}>
            <span aria-hidden="true" className="size-1.5 rounded-full" style={{ background: count > 0 ? t.success : t.muted }} />
            {count === 0 ? "No services yet" : `Routes to ${count} ${count === 1 ? "service" : "services"}`}
          </span>
        </div>

        <div className="flex items-center gap-2 rounded-xl border p-1.5 pl-3" style={{ borderColor: t.borderStrong, background: t.sunken }}>
          <code aria-label="Matrix MCP URL" className="min-w-0 flex-1 truncate text-sm" style={{ fontFamily: t.mono, color: t.text }}>{endpointUrl}</code>
          <CopyButton label="Copy Matrix MCP URL" done={copied === "url"} failed={failed === "url"} onClick={() => { void copy("url", endpointUrl); }} />
        </div>

        <div aria-hidden="true" className="flex flex-wrap items-center gap-2 text-xs" style={{ color: t.muted }}>
          {CLIENT_CHIPS.map(name => (
            <span key={name} className="rounded-md border px-2 py-1" style={{ borderColor: t.border, background: t.surface, color: t.secondary }}>{name}</span>
          ))}
          <ArrowRight size={14} />
          <span className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-medium" style={{ background: t.primary, color: t.primaryFg }}>
            <Waypoints size={12} /> Matrix
          </span>
          <ArrowRight size={14} />
          {count > 0 ? <McpServiceLogoStack services={connectedServices} size={24} /> : (
            <span className="flex items-center gap-1 opacity-60">
              {["linear", "hubspot", "gmail", "notion"].map(id => <McpServiceLogo key={id} presetId={id} name={id} size={20} />)}
            </span>
          )}
        </div>
      </div>

      <div className="border-t p-5 pt-4" style={{ borderColor: t.border }}>
        <div role="tablist" aria-label="Connect a client" className="flex flex-wrap gap-1">
          {setups.map(setup => (
            <button key={setup.id} type="button" role="tab" aria-selected={setup.id === client} onClick={() => setClient(setup.id)}
              className="rounded-lg px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-2"
              style={setup.id === client ? { background: t.sunken, color: t.text } : { color: t.muted }}>
              {setup.label}
            </button>
          ))}
        </div>
        <div role="tabpanel" aria-label={`${active.label} setup`} className="mt-3 overflow-hidden rounded-xl border" style={{ borderColor: t.border, background: t.sunken }}>
          <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5" style={{ borderColor: t.border }}>
            <span className="text-[11px] font-medium uppercase tracking-wide" style={{ color: t.muted }}>{active.snippetLabel}</span>
            <CopyButton compact label={`Copy ${active.label} setup`} done={copied === active.id} failed={failed === active.id} onClick={() => { void copy(active.id, active.snippet); }} />
          </div>
          <pre className="overflow-x-auto px-3 py-2.5 text-xs leading-relaxed" style={{ fontFamily: t.mono, color: t.text }}>{active.snippet}</pre>
        </div>
        <p className="mt-2 text-xs" style={{ color: t.muted }}>{active.hint} Writes from outside Matrix wait for your approval below.</p>
      </div>
    </section>
  );
}
