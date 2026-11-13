"use client";

import { Plus, Search } from "lucide-react";
import { useState } from "react";
import { REMOTE_MCP_DEPARTMENTS, type RemoteMcpDepartment } from "@matrix-os/contracts/remote-mcp-catalog";
import { McpServiceLogo } from "./McpServiceLogo.js";
import { mcpTokens as t } from "./mcp-settings-tokens.js";
import { REMOTE_MCP_DEPARTMENT_LABELS, filterRemoteMcpPresets, type RemoteMcpPreset } from "./remote-mcp-presets.js";


export interface RemoteMcpPresetPickerProps {
  presets: readonly RemoteMcpPreset[];
  state: "loading" | "ready" | "error";
  /** Saved MCP servers; a preset reflects its server's real status, not just that a row exists. */
  connections: ReadonlyArray<{ serverId: string; url: string; status: string }>;
  connectingId: string | null;
  disabled?: boolean;
  onConnect: (presetId: string) => void;
  /** Restart sign-in for a saved server that still needs OAuth authorization. */
  onFinishSignIn: (serverId: string) => void;
  onRetry: () => void;
}

function normalized(url: string): string {
  try {
    return new URL(url).href;
  } catch (error: unknown) {
    if (error instanceof TypeError) return url;
    throw error;
  }
}

/** Shared preset picker for Web Canvas, Web Desktop, and Electron Desktop (spec 2691). */
export function RemoteMcpPresetPicker({ presets, state, connections, connectingId, disabled = false, onConnect, onFinishSignIn, onRetry }: RemoteMcpPresetPickerProps) {
  const [query, setQuery] = useState("");
  const [department, setDepartment] = useState<RemoteMcpDepartment | null>(null);
  const byUrl = new Map(connections.map(connection => [normalized(connection.url), connection]));
  const visible = filterRemoteMcpPresets(presets, { query, department });

  return (
    <section aria-label="MCP services" className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-[220px] flex-1 items-center gap-2.5 rounded-xl border px-3 py-2 focus-within:ring-2 focus-within:ring-current"
          style={{ borderColor: t.border, background: t.surface }}>
          <Search size={15} aria-hidden="true" style={{ color: t.muted }} />
          <input type="search" aria-label="Search MCP services" placeholder="Search Linear, HubSpot, Notion…" value={query} maxLength={80}
            onChange={event => setQuery(event.target.value)}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none" style={{ color: t.text }} />
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5" aria-label="Department filters">
        <FilterChip label="All" active={department === null} onClick={() => setDepartment(null)} />
        {REMOTE_MCP_DEPARTMENTS.map(id => (
          <FilterChip key={id} label={REMOTE_MCP_DEPARTMENT_LABELS[id]} active={department === id} onClick={() => setDepartment(department === id ? null : id)} />
        ))}
      </div>
      {state === "loading" ? (
        <div role="status" aria-label="Loading MCP services" className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          <span className="sr-only">Loading MCP services…</span>
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} aria-hidden="true" className="h-[72px] animate-pulse rounded-xl border" style={{ borderColor: t.border, background: t.sunken }} />
          ))}
        </div>
      ) : null}
      {state === "error" ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed py-8 text-center" role="status" style={{ borderColor: t.border }}>
          <p className="text-sm font-medium" style={{ color: t.text }}>Could not load MCP services</p>
          <p className="text-sm" style={{ color: t.muted }}>You can still add any MCP server by URL below.</p>
          <button type="button" aria-label="Retry loading MCP services" onClick={onRetry} className="rounded-lg border px-3 py-1.5 text-sm" style={{ borderColor: t.borderStrong, color: t.text }}>Retry</button>
        </div>
      ) : null}
      {state === "ready" && visible.length === 0 ? (
        <div className="rounded-xl border border-dashed py-8 text-center" role="status" style={{ borderColor: t.border }}>
          <p className="text-sm font-medium" style={{ color: t.text }}>{presets.length === 0 ? "No services available" : "No services match"}</p>
          <p className="mt-1 text-sm" style={{ color: t.muted }}>{presets.length === 0 ? "Add any MCP server by URL below." : "Try another search or department, or add the server by URL below."}</p>
        </div>
      ) : null}
      {state === "ready" && visible.length > 0 ? (
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map(preset => {
            const saved = byUrl.get(normalized(preset.url));
            const isConnecting = connectingId === preset.id;
            const ready = saved?.status === "ready";
            return (
              <li key={preset.id} data-testid={`mcp-preset-${preset.id}`}
                className="flex min-w-0 items-center gap-3 rounded-xl border p-3 transition-colors"
                style={{ borderColor: ready ? `color-mix(in srgb, ${t.success} 35%, transparent)` : t.border, background: t.surface }}>
                <McpServiceLogo presetId={preset.id} name={preset.name} size={40} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium" style={{ color: t.text }}>{preset.name}</p>
                  <p className="line-clamp-2 text-xs leading-snug" style={{ color: t.muted }} title={preset.description}>{preset.description}</p>
                </div>
                {saved ? <SavedPresetState name={preset.name} saved={saved} disabled={disabled || connectingId !== null} onFinishSignIn={onFinishSignIn} /> : (
                  <button type="button" aria-label={`Connect ${preset.name}`} disabled={disabled || connectingId !== null} onClick={() => onConnect(preset.id)}
                    className="inline-flex shrink-0 items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors hover:brightness-95 disabled:opacity-50"
                    style={{ borderColor: t.borderStrong, color: t.text, background: t.surface }}>
                    {isConnecting ? "Connecting…" : <><Plus size={13} aria-hidden="true" />Connect</>}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick}
      className="rounded-full border px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-2"
      style={active
        ? { background: t.primary, color: t.primaryFg, borderColor: "transparent" }
        : { color: t.secondary, borderColor: t.border, background: t.surface }}>
      {label}
    </button>
  );
}

function SavedPresetState({ name, saved, disabled, onFinishSignIn }: {
  name: string; saved: { serverId: string; status: string }; disabled: boolean; onFinishSignIn: (serverId: string) => void;
}) {
  if (saved.status === "auth_required") {
    return (
      <button type="button" aria-label={`Finish sign-in for ${name}`} disabled={disabled} onClick={() => onFinishSignIn(saved.serverId)}
        className="shrink-0 rounded-lg px-2.5 py-1.5 text-xs font-medium disabled:opacity-50"
        style={{ background: `color-mix(in srgb, ${t.warning} 18%, transparent)`, color: t.text }}>Finish sign-in</button>
    );
  }
  const label = saved.status === "ready" ? "Connected" : saved.status === "disabled" ? "Disabled" : "Needs attention";
  const color = saved.status === "ready" ? t.success : saved.status === "disabled" ? t.muted : t.warning;
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
      style={{ background: `color-mix(in srgb, ${color} 14%, transparent)`, color: t.text }}>
      <span aria-hidden="true" className="size-1.5 rounded-full" style={{ background: color }} />
      <span>{label}</span>
    </span>
  );
}
