"use client";

import type { ReactNode } from "react";
import type { McpInventoryEntry } from "./remote-mcp-presets.js";

const muted = { color: "var(--text-tertiary, var(--muted-foreground))" };

export interface McpConnectionInventoryProps {
  entries: readonly McpInventoryEntry[];
  /** Surface-owned controls for an MCP server row (authorize, remove, tool policy). */
  renderActions?: (entry: Extract<McpInventoryEntry, { kind: "mcp" }>) => ReactNode;
  renderDetails?: (entry: Extract<McpInventoryEntry, { kind: "mcp" }>) => ReactNode;
}

/** The user's connections: MCP servers plus read-only legacy connected apps. */
export function McpConnectionInventory({ entries, renderActions, renderDetails }: McpConnectionInventoryProps) {
  if (entries.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border/60 p-6 text-center" role="status">
        <p className="text-sm font-medium">No connections yet</p>
        <p className="mt-1 text-sm" style={muted}>Pick a service above or paste any MCP server URL to connect it.</p>
      </div>
    );
  }
  return (
    <ul aria-label="Your connections" className="space-y-3">
      {entries.map(entry => (
        <li key={`${entry.kind}:${entry.id}`} className="rounded-lg border border-border/60 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{entry.name}</p>
              <p className="text-xs" style={muted}>
                {entry.kind === "mcp"
                  ? `MCP server · ${entry.statusLabel}`
                  : `Connected app · ${entry.accountLabel ? `${entry.accountLabel} · ` : ""}${entry.statusLabel}`}
              </p>
            </div>
            {entry.kind === "mcp" && renderActions ? <div className="flex gap-2">{renderActions(entry)}</div> : null}
          </div>
          {entry.kind === "mcp" && renderDetails ? renderDetails(entry) : null}
        </li>
      ))}
    </ul>
  );
}
