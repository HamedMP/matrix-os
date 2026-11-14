"use client";

import { useState } from "react";
import { REMOTE_MCP_DEPARTMENTS, type RemoteMcpDepartment } from "@matrix-os/contracts/remote-mcp-catalog";
import { REMOTE_MCP_DEPARTMENT_LABELS, filterRemoteMcpPresets, type RemoteMcpPreset } from "./remote-mcp-presets.js";

const muted = { color: "var(--text-tertiary, var(--muted-foreground))" };
const pill = { background: "var(--bg-surface-hover, var(--muted))" };

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
      <div className="flex items-center gap-3 rounded-full border px-4 py-2.5" style={{ borderColor: "var(--border-subtle, var(--border))", ...pill }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true" style={muted}>
          <circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" />
        </svg>
        <input type="search" aria-label="Search MCP services" placeholder="Search services" value={query} maxLength={80}
          onChange={event => setQuery(event.target.value)}
          className="min-w-0 flex-1 rounded-sm bg-transparent text-sm outline-none focus-visible:ring-2 focus-visible:ring-current" />
      </div>
      <div className="flex flex-wrap gap-1" aria-label="Department filters">
        <button type="button" aria-pressed={department === null} onClick={() => setDepartment(null)}
          className="rounded-full px-3 py-1.5 text-xs focus-visible:outline-2" style={department === null ? pill : muted}>All</button>
        {REMOTE_MCP_DEPARTMENTS.map(id => (
          <button key={id} type="button" aria-pressed={department === id} onClick={() => setDepartment(department === id ? null : id)}
            className="rounded-full px-3 py-1.5 text-xs focus-visible:outline-2" style={department === id ? pill : muted}>
            {REMOTE_MCP_DEPARTMENT_LABELS[id]}
          </button>
        ))}
      </div>
      {state === "loading" ? <p role="status" className="py-6 text-center text-sm" style={muted}>Loading MCP services…</p> : null}
      {state === "error" ? (
        <div className="flex flex-col items-center gap-2 py-6 text-center" role="status">
          <p className="text-sm font-medium">Could not load MCP services</p>
          <p className="text-sm" style={muted}>You can still paste any MCP server URL below.</p>
          <button type="button" aria-label="Retry loading MCP services" onClick={onRetry} className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted">Retry</button>
        </div>
      ) : null}
      {state === "ready" && visible.length === 0 ? (
        <div className="py-6 text-center" role="status">
          <p className="text-sm font-medium">{presets.length === 0 ? "No services available" : "No services match"}</p>
          <p className="mt-1 text-sm" style={muted}>{presets.length === 0 ? "Paste any MCP server URL below to connect it." : "Try another search or department, or paste an MCP URL below."}</p>
        </div>
      ) : null}
      {state === "ready" && visible.length > 0 ? (
        <ul className="grid grid-cols-1 gap-x-8 gap-y-1 sm:grid-cols-2">
          {visible.map(preset => {
            const saved = byUrl.get(normalized(preset.url));
            const isConnecting = connectingId === preset.id;
            return (
              <li key={preset.id} className="flex min-w-0 items-center gap-3 py-3" data-testid={`mcp-preset-${preset.id}`}>
                <div aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-lg text-sm font-semibold" style={pill}>
                  {preset.name.charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{preset.name}</p>
                  <p className="truncate text-xs" style={muted} title={preset.description}>{preset.description}</p>
                </div>
                {saved ? <SavedPresetState name={preset.name} saved={saved} disabled={disabled || connectingId !== null} onFinishSignIn={onFinishSignIn} /> : (
                  <button type="button" aria-label={`Connect ${preset.name}`} disabled={disabled || connectingId !== null} onClick={() => onConnect(preset.id)}
                    className="shrink-0 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50">
                    {isConnecting ? "Connecting…" : "Connect"}
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

function SavedPresetState({ name, saved, disabled, onFinishSignIn }: {
  name: string; saved: { serverId: string; status: string }; disabled: boolean; onFinishSignIn: (serverId: string) => void;
}) {
  if (saved.status === "auth_required") {
    return (
      <button type="button" aria-label={`Finish sign-in for ${name}`} disabled={disabled} onClick={() => onFinishSignIn(saved.serverId)}
        className="shrink-0 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50">Finish sign-in</button>
    );
  }
  const label = saved.status === "ready" ? "Connected" : saved.status === "disabled" ? "Disabled" : "Needs attention";
  return <span className="shrink-0 rounded-full px-2.5 py-1 text-xs" style={pill}>{label}</span>;
}
