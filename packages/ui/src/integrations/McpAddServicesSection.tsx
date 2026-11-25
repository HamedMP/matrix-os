"use client";

import * as Collapsible from "@radix-ui/react-collapsible";
import { Plus } from "lucide-react";
import { useState, type ReactNode } from "react";
import { McpSectionHeading } from "./McpConnectionInventory.js";
import { mcpTokens as t } from "./mcp-settings-tokens.js";

export interface McpAddServicesSectionProps {
  /**
   * Whether the user has any connection, or undefined while that is still loading
   * (or failed to load, so the disabled form stays visible next to Retry).
   * The first known value picks the state: open with nothing connected, collapsed
   * behind Add MCP otherwise. Later changes (a preset just connected) never yank
   * the gallery shut mid-flow.
   */
  hasConnections: boolean | undefined;
  /** The preset gallery and custom server form. */
  children: ReactNode;
}

/** "Add more" section shared by the MCP settings renderers: the gallery opens on demand. */
export function McpAddServicesSection({ hasConnections, children }: McpAddServicesSectionProps) {
  const [latchedOpen, setLatchedOpen] = useState<boolean | null>(null);
  if (latchedOpen === null && hasConnections !== undefined) setLatchedOpen(!hasConnections);
  const open = latchedOpen ?? true;
  return (
    <Collapsible.Root open={open} onOpenChange={setLatchedOpen} className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <McpSectionHeading title="Add more" description="Pick a service from the gallery or add any MCP server by URL. Matrix keeps the credentials." />
        <Collapsible.Trigger
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors hover:brightness-95 focus-visible:outline focus-visible:outline-2 disabled:opacity-50"
          style={open
            ? { color: t.text, borderColor: t.borderStrong, background: "transparent" }
            : { color: t.primaryFg, borderColor: "transparent", background: t.primary }}>
          <Plus aria-hidden="true" size={14} className="transition-transform" style={{ transform: open ? "rotate(45deg)" : undefined }} />
          Add MCP
        </Collapsible.Trigger>
      </div>
      <Collapsible.Content className="space-y-8">{children}</Collapsible.Content>
    </Collapsible.Root>
  );
}
