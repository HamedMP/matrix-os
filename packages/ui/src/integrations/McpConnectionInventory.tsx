"use client";

import { Plug } from "lucide-react";
import type { ReactNode } from "react";
import { McpServiceLogo } from "./McpServiceLogo.js";
import { mcpTokens as t, toneColor, type McpStatusTone } from "./mcp-settings-tokens.js";
import type { McpInventoryEntry } from "./remote-mcp-presets.js";

export interface McpConnectionInventoryProps {
  entries: readonly McpInventoryEntry[];
  /** Surface-owned controls for an MCP server row (authorize, remove, tool policy). */
  renderActions?: (entry: Extract<McpInventoryEntry, { kind: "mcp" }>) => ReactNode;
  renderDetails?: (entry: Extract<McpInventoryEntry, { kind: "mcp" }>) => ReactNode;
}

const LABEL_TONES: Record<string, McpStatusTone> = {
  Connected: "success", "Sign-in required": "warning", "Action required": "warning", "Needs attention": "warning",
  Degraded: "danger", Disabled: "neutral", Pending: "neutral",
};

export function McpStatusPill({ label }: { label: string }) {
  const color = toneColor(LABEL_TONES[label] ?? "warning");
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium"
      style={{ background: `color-mix(in srgb, ${color} 14%, transparent)`, color: t.text }}>
      <span aria-hidden="true" className="size-1.5 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}

/** The user's connections: MCP servers plus read-only legacy connected apps. */
export function McpConnectionInventory({ entries, renderActions, renderDetails }: McpConnectionInventoryProps) {
  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center rounded-2xl border border-dashed px-6 py-8 text-center" role="status" style={{ borderColor: t.border }}>
        <span aria-hidden="true" className="flex size-10 items-center justify-center rounded-xl" style={{ background: t.sunken, color: t.muted }}><Plug size={18} /></span>
        <p className="mt-3 text-sm font-medium" style={{ color: t.text }}>No connections yet</p>
        <p className="mt-1 max-w-sm text-sm" style={{ color: t.muted }}>Pick a service below or add any MCP server by URL. Each one you connect becomes available through your Matrix MCP.</p>
      </div>
    );
  }
  return (
    <ul aria-label="Your connections" className="space-y-2">
      {entries.map(entry => {
        const needsSignIn = entry.statusLabel === "Sign-in required";
        return (
        <li key={`${entry.kind}:${entry.id}`} className="rounded-2xl border"
          style={needsSignIn
            ? { borderColor: `color-mix(in srgb, ${t.warning} 40%, transparent)`, background: `color-mix(in srgb, ${t.warning} 8%, ${t.surface})` }
            : { borderColor: t.border, background: t.surface }}>
          <div className="flex flex-wrap items-center gap-3 p-4">
            <McpServiceLogo presetId={entry.kind === "mcp" ? entry.presetId : undefined} name={entry.name} size={40} />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <p className="truncate text-sm font-medium" style={{ color: t.text }}>{entry.name}</p>
                <McpStatusPill label={entry.statusLabel} />
              </div>
              <p className="mt-0.5 text-xs" style={{ color: t.muted }}>
                {entry.kind === "mcp"
                  ? needsSignIn ? "Finish signing in so agents and clients can use it." : "MCP server · available through your Matrix MCP"
                  : `Connected app${entry.accountLabel ? ` · ${entry.accountLabel}` : ""} · managed in Connect Apps`}
              </p>
            </div>
            {entry.kind === "mcp" && renderActions ? <div className="flex shrink-0 items-center gap-1.5">{renderActions(entry)}</div> : null}
          </div>
          {entry.kind === "mcp" && renderDetails ? (
            <div className="border-t px-4 pb-4" style={{ borderColor: t.border }}>{renderDetails(entry)}</div>
          ) : null}
        </li>
        );
      })}
    </ul>
  );
}

/** Section heading shared by the MCP settings renderers. */
export function McpSectionHeading({ title, count, description, id }: { title: string; count?: number; description?: string; id?: string }) {
  return (
    <div className="space-y-0.5">
      <h4 id={id} className="text-base font-semibold tracking-tight" style={{ color: t.text }}>
        {title}{count !== undefined ? <span className="ml-1.5 font-normal" style={{ color: t.muted }}>{count}</span> : null}
      </h4>
      {description ? <p className="text-sm" style={{ color: t.secondary }}>{description}</p> : null}
    </div>
  );
}
