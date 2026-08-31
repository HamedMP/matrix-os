import type { PaneNode } from "@/stores/terminal-store";
import { isCanonicalShellSessionId } from "./terminal-session-id";
import { twoWordSessionName } from "./terminal-session-names";

export const DEFAULT_CWD = "projects";

export interface Tab {
  id: string;
  label: string;
  paneTree: PaneNode;
}

export interface TerminalLayout {
  tabs?: Tab[];
  activeTabId?: string;
  sidebarOpen?: boolean;
}

function layoutValueEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeLayoutValue<T>(base: T, local: T, remote: T): T {
  if (layoutValueEqual(local, remote)) return local;
  if (layoutValueEqual(local, base)) return remote;
  if (layoutValueEqual(remote, base)) return local;
  return remote;
}

function mergeOptionalPaneValue<T>(
  base: T | undefined,
  local: T | undefined,
  remote: T | undefined,
): T | undefined {
  if (base !== undefined && (local === undefined || remote === undefined)) return undefined;
  return mergeLayoutValue(base, local, remote);
}

function findPaneById(node: PaneNode, paneId: string): Extract<PaneNode, { type: "pane" }> | null {
  if (node.type === "pane") return node.id === paneId ? node : null;
  return findPaneById(node.children[0], paneId) ?? findPaneById(node.children[1], paneId);
}

function mergePaneTrees(base: PaneNode, local: PaneNode, remote: PaneNode): PaneNode {
  if (layoutValueEqual(local, remote)) return local;
  if (layoutValueEqual(local, base)) return remote;
  if (layoutValueEqual(remote, base)) return local;
  if (base.type !== local.type || base.type !== remote.type) {
    if (remote.type === "pane") {
      const basePane = findPaneById(base, remote.id);
      const localPane = findPaneById(local, remote.id);
      if (basePane && localPane) return mergePaneTrees(basePane, localPane, remote);
    }
    if (local.type === "pane") {
      const basePane = findPaneById(base, local.id);
      const remotePane = findPaneById(remote, local.id);
      if (basePane && remotePane) return mergePaneTrees(basePane, local, remotePane);
    }
    return remote;
  }

  if (base.type === "pane" && local.type === "pane" && remote.type === "pane") {
    if (base.id !== local.id || base.id !== remote.id) return remote;
    const sessionId = mergeOptionalPaneValue(base.sessionId, local.sessionId, remote.sessionId);
    const claudeMode = mergeOptionalPaneValue(base.claudeMode, local.claudeMode, remote.claudeMode);
    const startupCommand = mergeOptionalPaneValue(base.startupCommand, local.startupCommand, remote.startupCommand);
    const compatMode = mergeOptionalPaneValue(base.compatMode, local.compatMode, remote.compatMode);
    return {
      type: "pane",
      id: base.id,
      cwd: mergeLayoutValue(base.cwd, local.cwd, remote.cwd),
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(claudeMode === undefined ? {} : { claudeMode }),
      ...(startupCommand === undefined ? {} : { startupCommand }),
      ...(compatMode === undefined ? {} : { compatMode }),
    };
  }

  if (base.type === "split" && local.type === "split" && remote.type === "split") {
    return {
      type: "split",
      direction: mergeLayoutValue(base.direction, local.direction, remote.direction),
      ratio: mergeLayoutValue(base.ratio, local.ratio, remote.ratio),
      children: [
        mergePaneTrees(base.children[0], local.children[0], remote.children[0]),
        mergePaneTrees(base.children[1], local.children[1], remote.children[1]),
      ],
    };
  }

  return remote;
}

/** Three-way merge for concurrent Terminal windows. Tab/pane deletion wins over stale references. */
export function mergeTerminalLayouts(
  base: TerminalLayout,
  local: TerminalLayout,
  remote: TerminalLayout,
): TerminalLayout {
  const baseTabs = base.tabs ?? [];
  const localTabs = local.tabs ?? [];
  const remoteTabs = remote.tabs ?? [];
  const localOrderUnchanged = layoutValueEqual(
    localTabs.map((tab) => tab.id),
    baseTabs.map((tab) => tab.id),
  );
  const candidateIds = [
    ...(localOrderUnchanged ? remoteTabs : localTabs).map((tab) => tab.id),
    ...localTabs.map((tab) => tab.id),
    ...remoteTabs.map((tab) => tab.id),
  ];
  const orderedIds = candidateIds.filter((id, index) => candidateIds.indexOf(id) === index);
  const tabs = orderedIds.flatMap((id) => {
    const baseTab = baseTabs.find((tab) => tab.id === id);
    const localTab = localTabs.find((tab) => tab.id === id);
    const remoteTab = remoteTabs.find((tab) => tab.id === id);
    if (!baseTab) return localTab ? [localTab] : remoteTab ? [remoteTab] : [];
    if (!localTab || !remoteTab) return [];
    return [{
      id,
      label: mergeLayoutValue(baseTab.label, localTab.label, remoteTab.label),
      paneTree: mergePaneTrees(baseTab.paneTree, localTab.paneTree, remoteTab.paneTree),
    }];
  });
  const requestedActiveTabId = mergeLayoutValue(
    base.activeTabId,
    local.activeTabId,
    remote.activeTabId,
  );
  const activeTabId = tabs.some((tab) => tab.id === requestedActiveTabId)
    ? requestedActiveTabId
    : tabs.find((tab) => tab.id === local.activeTabId)?.id
      ?? tabs.find((tab) => tab.id === remote.activeTabId)?.id
      ?? tabs[0]?.id
      ?? "";
  return {
    tabs,
    activeTabId,
    sidebarOpen: mergeLayoutValue(base.sidebarOpen, local.sidebarOpen, remote.sidebarOpen),
  };
}

export function genId() {
  return Math.random().toString(36).slice(2, 9);
}

export function terminalSessionName() {
  return twoWordSessionName();
}

export function splitPaneInTree(node: PaneNode, paneId: string, dir: "horizontal" | "vertical"): PaneNode {
  if (node.type === "pane") {
    if (node.id === paneId) {
      return { type: "split", direction: dir, children: [node, { type: "pane", id: genId(), cwd: node.cwd }], ratio: 0.5 };
    }
    return node;
  }
  return { ...node, children: [splitPaneInTree(node.children[0], paneId, dir), splitPaneInTree(node.children[1], paneId, dir)] };
}

export function closePaneInTree(node: PaneNode, paneId: string): PaneNode | null {
  if (node.type === "pane") return node.id === paneId ? null : node;
  const l = node.children[0], r = node.children[1];
  if (l.type === "pane" && l.id === paneId) return r;
  if (r.type === "pane" && r.id === paneId) return l;
  const nl = closePaneInTree(l, paneId);
  const nr = closePaneInTree(r, paneId);
  if (!nl) return nr;
  if (!nr) return nl;
  if (nl === l && nr === r) return node;
  return { ...node, children: [nl, nr] };
}

export function getFirstPaneId(node: PaneNode): string {
  if (node.type === "pane") return node.id;
  return getFirstPaneId(node.children[0]);
}

export function compatModeForShellSession(sessionId: string | undefined) {
  return sessionId?.startsWith("codex-") ? "codex-tui" as const : undefined;
}

export function setPaneSessionId(node: PaneNode, paneId: string, sessionId: string): PaneNode {
  if (node.type === "pane") {
    if (node.id !== paneId || node.sessionId === sessionId) {
      return node;
    }
    return { ...node, sessionId, compatMode: compatModeForShellSession(sessionId) };
  }

  const left = setPaneSessionId(node.children[0], paneId, sessionId);
  const right = setPaneSessionId(node.children[1], paneId, sessionId);
  if (left === node.children[0] && right === node.children[1]) {
    return node;
  }
  return { ...node, children: [left, right] };
}

export function renameSessionInTree(node: PaneNode, fromSessionId: string, toSessionId: string): PaneNode {
  if (node.type === "pane") {
    return node.sessionId === fromSessionId
      ? { ...node, sessionId: toSessionId, compatMode: compatModeForShellSession(toSessionId) }
      : node;
  }
  const left = renameSessionInTree(node.children[0], fromSessionId, toSessionId);
  const right = renameSessionInTree(node.children[1], fromSessionId, toSessionId);
  if (left === node.children[0] && right === node.children[1]) {
    return node;
  }
  return { ...node, children: [left, right] };
}

export function hasPaneId(node: PaneNode, paneId: string): boolean {
  if (node.type === "pane") {
    return node.id === paneId;
  }
  return hasPaneId(node.children[0], paneId) || hasPaneId(node.children[1], paneId);
}

export function getPaneSessionId(node: PaneNode, paneId: string): string | null {
  if (node.type === "pane") {
    return node.id === paneId ? node.sessionId ?? null : null;
  }
  return getPaneSessionId(node.children[0], paneId) ?? getPaneSessionId(node.children[1], paneId);
}

export function getPaneCwd(node: PaneNode, paneId: string): string | null {
  if (node.type === "pane") {
    return node.id === paneId ? node.cwd : null;
  }
  return getPaneCwd(node.children[0], paneId) ?? getPaneCwd(node.children[1], paneId);
}

export function formatCwd(value: string): string {
  if (value === DEFAULT_CWD) return "~/projects";
  if (value.startsWith(DEFAULT_CWD + "/")) return `~/${value}`;
  return value;
}

export function getSessionIds(node: PaneNode): string[] {
  if (node.type === "pane") {
    return node.sessionId ? [node.sessionId] : [];
  }
  return [...getSessionIds(node.children[0]), ...getSessionIds(node.children[1])];
}

export function getPaneIdsForSession(node: PaneNode, sessionId: string): string[] {
  if (node.type === "pane") {
    return node.sessionId === sessionId ? [node.id] : [];
  }
  return [
    ...getPaneIdsForSession(node.children[0], sessionId),
    ...getPaneIdsForSession(node.children[1], sessionId),
  ];
}

export function removeSessionFromPaneTree(node: PaneNode, sessionId: string): PaneNode | null {
  if (node.type === "pane") {
    return node.sessionId === sessionId ? null : node;
  }
  const left = removeSessionFromPaneTree(node.children[0], sessionId);
  const right = removeSessionFromPaneTree(node.children[1], sessionId);
  if (!left) return right;
  if (!right) return left;
  if (left === node.children[0] && right === node.children[1]) {
    return node;
  }
  return { ...node, children: [left, right] };
}

export function layoutUsesOnlyCanonicalShellSessions(layout: TerminalLayout): boolean {
  if (!Array.isArray(layout.tabs) || layout.tabs.length === 0) {
    return false;
  }
  const sessionIds = layout.tabs.flatMap((tab) => getSessionIds(tab.paneTree));
  return sessionIds.length > 0 && sessionIds.every((sessionId) => isCanonicalShellSessionId(sessionId));
}

export function getCanonicalShellSessionIds(layout: TerminalLayout): string[] {
  if (!Array.isArray(layout.tabs)) {
    return [];
  }
  const seen = new Set<string>();
  for (const tab of layout.tabs) {
    for (const sessionId of getSessionIds(tab.paneTree)) {
      if (isCanonicalShellSessionId(sessionId)) {
        seen.add(sessionId);
      }
    }
  }
  return Array.from(seen);
}

export function applyCompatModeToPaneTree(node: PaneNode): PaneNode {
  if (node.type === "pane") {
    return {
      ...node,
      compatMode: node.compatMode ?? compatModeForShellSession(node.sessionId),
    };
  }
  return {
    ...node,
    children: [
      applyCompatModeToPaneTree(node.children[0]),
      applyCompatModeToPaneTree(node.children[1]),
    ],
  };
}

export function applyCompatModeToTabs(tabs: Tab[]): Tab[] {
  return tabs.map((tab) => ({ ...tab, paneTree: applyCompatModeToPaneTree(tab.paneTree) }));
}
