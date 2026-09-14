import type { RuntimeSummary, TerminalRef, TerminalTab } from "@matrix-os/contracts";

export type RuntimeTerminalTab = TerminalTab & {
  projectId?: string;
  workspaceRevision: number;
  attachable: boolean;
  ref: TerminalRef;
  refKey: string;
};

export function terminalRefKey(ref: TerminalRef): string {
  return `${ref.workspaceId}:${ref.tabId}`;
}

export function parseTerminalRefKey(value: string): TerminalRef | null {
  const [workspaceId, tabId, extra] = value.split(":");
  if (
    extra !== undefined
    || !/^tws_[0-9a-f]{32}$/.test(workspaceId ?? "")
    || !/^tt_[0-9a-f]{32}$/.test(tabId ?? "")
  ) return null;
  return { workspaceId: workspaceId!, tabId: tabId! };
}

export function runtimeTerminalTabs(summary: Pick<RuntimeSummary, "terminalWorkspaces">): RuntimeTerminalTab[] {
  return summary.terminalWorkspaces.items.flatMap((workspace) => workspace.tabs.map((tab) => {
    const ref = { workspaceId: workspace.id, tabId: tab.id };
    return {
      ...tab,
      ...(workspace.scope === "project" ? { projectId: workspace.projectId } : {}),
      workspaceRevision: workspace.revision,
      attachable: tab.status === "running" || tab.status === "idle" || tab.status === "starting",
      ref,
      refKey: terminalRefKey(ref),
    };
  }));
}
