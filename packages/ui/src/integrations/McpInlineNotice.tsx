"use client";

import type { ReactNode } from "react";
import { mcpTokens as t, toneColor, type McpStatusTone } from "./mcp-settings-tokens.js";

/** Compact one-line notice for MCP settings load failures and similar states. */
export function McpInlineNotice({ role = "status", tone = "warning", icon, title, description, action }: {
  role?: "status" | "alert";
  tone?: McpStatusTone;
  icon: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  const color = toneColor(tone);
  return (
    <div role={role} className="flex flex-wrap items-center gap-3 rounded-xl border px-3.5 py-2.5"
      style={{ borderColor: t.border, background: t.surface }}>
      <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-lg"
        style={{ background: `color-mix(in srgb, ${color} 14%, transparent)`, color }}>{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium" style={{ color: t.text }}>{title}</p>
        {description ? <p className="text-xs" style={{ color: t.muted }}>{description}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
