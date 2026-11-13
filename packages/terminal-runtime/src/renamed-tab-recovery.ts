import type { TerminalRuntimeTabState, TerminalRuntimeWorkspaceState } from "./workspace-store.js";

/**
 * Runtimes before ENG-466 renamed the Zellij tab to the user's display name, so restore could
 * no longer find it by its stable internal name. These helpers select the records that may be
 * repaired by their stored Zellij tab ID; the adapter proves identity against the live inventory.
 */
export interface RenamedTabCandidate {
  internalName: string;
  displayName: string;
  tabId: number;
  paneId: string | null;
  /** Exited records may only be revived when the stored pane is still present and not held. */
  requireLivePane: boolean;
}

type RuntimeIds = { tabId: number; paneId: string };

export function renamedTabCandidates(tabs: TerminalRuntimeTabState[], requireLivePane: boolean): RenamedTabCandidate[] {
  return tabs.flatMap((tab) => {
    if (tab.zellijTabId === null || (requireLivePane && tab.zellijPaneId === null)) return [];
    return [{
      internalName: tab.zellijTabName,
      displayName: tab.name,
      tabId: tab.zellijTabId,
      paneId: tab.zellijPaneId,
      requireLivePane,
    }];
  });
}

/** Restorable tabs missing by internal name, then exited records without an observed exit code. */
export function renamedTabRecoveryCandidates(
  workspace: TerminalRuntimeWorkspaceState,
  restorableTabs: TerminalRuntimeTabState[],
  located: ReadonlyMap<string, RuntimeIds>,
): RenamedTabCandidate[] {
  return [
    ...renamedTabCandidates(restorableTabs.filter((tab) => tab.status !== "starting" && !located.has(tab.id)), false),
    ...renamedTabCandidates(exitedWithoutCode(workspace), true),
  ];
}

export function revivableExitedTabs(
  workspace: TerminalRuntimeWorkspaceState,
  recovered: Record<string, RuntimeIds>,
): TerminalRuntimeTabState[] {
  return exitedWithoutCode(workspace)
    .filter((tab) => recovered[tab.zellijTabName] !== undefined)
    .sort((left, right) => left.order - right.order);
}

function exitedWithoutCode(workspace: TerminalRuntimeWorkspaceState): TerminalRuntimeTabState[] {
  return Object.values(workspace.tabs).filter((tab) => tab.status === "exited" && tab.exitCode === null);
}
