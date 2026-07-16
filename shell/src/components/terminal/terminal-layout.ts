import { getGatewayUrl } from "@/lib/gateway";
import type { PaneNode } from "@/stores/terminal-store";
import { isCanonicalShellSessionId, isLegacyPtySessionId } from "./terminal-session-id";
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

export function genId() {
  return Math.random().toString(36).slice(2, 9);
}

export function terminalSessionName(prefix = "matrix", options: { collisionFallback?: boolean } = {}) {
  const normalized = prefix.toLowerCase();
  // A meaningful prefix (e.g. a project name) keeps the prefixed form; the
  // default produces a friendly two-word handle instead of matrix-<random>.
  if (normalized && normalized !== "matrix") {
    const safePrefix = normalized
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/^-+/, "")
      .slice(0, 22) || "matrix";
    return `${safePrefix}-${genId()}`.slice(0, 31);
  }
  return twoWordSessionName(options);
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

export function destroyTerminalSessions(sessionIds: string[]) {
  const uniqueIds = Array.from(new Set(sessionIds.filter((sessionId) => sessionId.length > 0)));
  for (const sessionId of uniqueIds) {
    const isCanonical = isCanonicalShellSessionId(sessionId);
    const isLegacyPty = isLegacyPtySessionId(sessionId);
    if (!isCanonical && !isLegacyPty) {
      continue;
    }
    const path = isCanonical
      ? `/api/terminal/sessions/${encodeURIComponent(sessionId)}?force=1`
      : `/api/terminal/pty-sessions/${encodeURIComponent(sessionId)}`;
    void fetch(`${getGatewayUrl()}${path}`, {
      method: "DELETE",
      keepalive: true,
      signal: AbortSignal.timeout(5_000),
    }).then((res) => {
      if (!res.ok && res.status !== 404) {
        console.warn(`Failed to destroy terminal session "${sessionId}" on explicit close: ${res.status}`);
      }
    }).catch((err: unknown) => {
      console.warn(
        `Failed to destroy terminal session "${sessionId}" on explicit close:`,
        err instanceof Error ? err.message : err,
      );
    });
  }
}
