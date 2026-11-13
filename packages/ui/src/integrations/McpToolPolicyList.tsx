"use client";

import type { ButtonHTMLAttributes } from "react";
import { mcpTokens as t } from "./mcp-settings-tokens.js";

export type McpToolApproval = "always_ask" | "allow";

export interface McpToolPolicyListProps {
  tools: ReadonlyArray<{ name: string; description: string; approval: McpToolApproval; enabled: boolean }>;
  serverEnabled: boolean;
  onToolEnabledChange: (toolName: string, enabled: boolean) => void;
  onToolApprovalChange: (toolName: string, approval: McpToolApproval) => void;
  onToggleServer: () => void;
}

/** Small row action used by every MCP settings renderer (Authorize, Remove, …). */
export function McpRowAction({ tone = "default", className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "default" | "danger" | "primary" }) {
  const style = tone === "primary"
    ? { background: t.primary, color: t.primaryFg, borderColor: "transparent" }
    : tone === "danger"
      ? { color: t.danger, borderColor: t.border, background: "transparent" }
      : { color: t.text, borderColor: t.borderStrong, background: "transparent" };
  return <button type="button" {...props}
    className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors hover:brightness-95 disabled:opacity-50 ${className ?? ""}`}
    style={style} />;
}

/** Per-tool on/off and approval policy for one MCP server, shared by Web and Electron settings. */
export function McpToolPolicyList({ tools, serverEnabled, onToolEnabledChange, onToolApprovalChange, onToggleServer }: McpToolPolicyListProps) {
  if (tools.length === 0) return null;
  const enabledCount = tools.filter(tool => tool.enabled).length;
  return (
    <div className="mt-3 overflow-hidden rounded-xl border" style={{ borderColor: t.border }}>
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2" style={{ background: t.sunken }}>
        <p className="text-xs" style={{ color: t.secondary }}>
          <span className="font-medium" style={{ color: t.text }}>Tools</span> · {enabledCount} of {tools.length} on
          {serverEnabled ? null : <span style={{ color: t.warning }}> · server turned off</span>}
        </p>
        <McpRowAction disabled={!tools.some(tool => tool.enabled)} onClick={onToggleServer}
          title={serverEnabled ? "Stop every agent and client from using this server" : "Let agents and clients use this server again"}>
          {serverEnabled ? "Disable" : "Enable"}
        </McpRowAction>
      </div>
      <ul className="divide-y" style={{ borderColor: t.border }}>
        {tools.map(tool => (
          <li key={tool.name} className="flex items-center gap-3 px-3 py-2" style={{ borderColor: t.border }}>
            <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
              <input type="checkbox" className="peer sr-only" checked={tool.enabled}
                onChange={event => onToolEnabledChange(tool.name, event.target.checked)} />
              <span aria-hidden="true"
                className="relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors peer-focus-visible:outline peer-focus-visible:outline-2"
                style={{ background: tool.enabled ? t.success : t.borderStrong }}>
                <span className="absolute size-3 rounded-full bg-white shadow transition-transform" style={{ transform: `translateX(${tool.enabled ? 14 : 2}px)` }} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium" style={{ fontFamily: t.mono, color: tool.enabled ? t.text : t.muted }}>{tool.name}</span>
                {tool.description ? <span className="block truncate text-xs" title={tool.description} style={{ color: t.muted }}>{tool.description}</span> : null}
              </span>
            </label>
            <select aria-label={`${tool.name} approval`} value={tool.approval}
              onChange={event => onToolApprovalChange(tool.name, event.target.value as McpToolApproval)}
              className="shrink-0 rounded-lg border px-2 py-1 text-xs"
              style={{ borderColor: t.borderStrong, background: t.surface, color: t.text }}>
              <option value="always_ask">Ask every time</option>
              <option value="allow">Always allow</option>
            </select>
          </li>
        ))}
      </ul>
    </div>
  );
}
