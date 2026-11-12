"use client";

import { ExternalMcpApprovalsIndicator, ExternalMcpApprovalsPanel } from "@matrix-os/ui";
import type { SettingsSectionId } from "@/components/Settings";
import { useShellExternalMcpApprovals } from "@/lib/external-mcp-approvals";

/** Notification-stack pill for pending external MCP writes; opens Settings → Integrations, where they are decided. */
export function ShellExternalMcpApprovalsPill({ openSettings }: { openSettings: (section: SettingsSectionId) => void }) {
  return <ExternalMcpApprovalsIndicator transport={useShellExternalMcpApprovals()} onOpen={() => openSettings("integrations")} />;
}

/** Settings → Integrations section for the same owner routes. */
export function ShellExternalMcpApprovalsSection() {
  return <div className="border-t border-border/60 pt-8"><ExternalMcpApprovalsPanel transport={useShellExternalMcpApprovals()} /></div>;
}
