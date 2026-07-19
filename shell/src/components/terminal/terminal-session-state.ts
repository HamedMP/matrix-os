export interface ShellSessionSummary {
  name: string;
  status?: "active" | "exited" | "degraded";
  placement?: "active" | "background";
  updatedAt?: string;
  attachedClients?: number;
  latestSeq?: number | null;
  lastSeenSeq?: number | null;
  unread?: boolean;
  visualStatus?: "running" | "waiting" | "finished" | "idle";
  agent?: "claude" | "codex" | "opencode" | "pi";
  subtitle?: string;
  lastAction?: string;
  agentUpdatedAt?: string;
  model?: string;
  strength?: string;
  project?: string;
  repository?: string;
  branch?: string;
  pullRequest?: { number: number; url?: string };
  attachCommand?: string;
  tabs?: Array<{ idx: number; name?: string; focused?: boolean }>;
}

export function getShellVisualStatus(
  shell: ShellSessionSummary,
): NonNullable<ShellSessionSummary["visualStatus"]> {
  if (shell.visualStatus) return shell.visualStatus;
  if (shell.status === "degraded") return "waiting";
  return shell.unread ? "finished" : "idle";
}

export type ShellUiStatePatch = Partial<Pick<ShellSessionSummary, "placement" | "lastSeenSeq">>;
type ShellUiStatePatchKey = keyof ShellUiStatePatch;

export interface ShellRefreshState {
  shells: ShellSessionSummary[];
  authoritative: boolean;
  stale: boolean;
  error: string | null;
}

const SHELL_UI_STATE_PATCH_KEYS: ShellUiStatePatchKey[] = ["placement", "lastSeenSeq"];

export function shellSessionsEqual(left: ShellSessionSummary[], right: ShellSessionSummary[]): boolean {
  return left.length === right.length && left.every((session, index) => {
    const next = right[index];
    if (!next) return false;
    if (
      session.name !== next.name ||
      session.status !== next.status ||
      session.placement !== next.placement ||
      session.updatedAt !== next.updatedAt ||
      session.attachedClients !== next.attachedClients ||
      session.latestSeq !== next.latestSeq ||
      session.lastSeenSeq !== next.lastSeenSeq ||
      session.unread !== next.unread ||
      session.visualStatus !== next.visualStatus ||
      session.agent !== next.agent ||
      session.subtitle !== next.subtitle ||
      session.lastAction !== next.lastAction ||
      session.agentUpdatedAt !== next.agentUpdatedAt ||
      session.model !== next.model ||
      session.strength !== next.strength ||
      session.project !== next.project ||
      session.repository !== next.repository ||
      session.branch !== next.branch ||
      session.pullRequest?.number !== next.pullRequest?.number ||
      session.pullRequest?.url !== next.pullRequest?.url ||
      session.attachCommand !== next.attachCommand
    ) {
      return false;
    }
    const tabs = session.tabs ?? [];
    const nextTabs = next.tabs ?? [];
    if (tabs.length !== nextTabs.length) return false;
    return tabs.every((tab, tabIndex) => {
      const nextTab = nextTabs[tabIndex];
      if (!nextTab) return false;
      return (
        tab.idx === nextTab.idx &&
        tab.name === nextTab.name &&
        tab.focused === nextTab.focused
      );
    });
  });
}

function getShellUiStatePatchKeys(patch: ShellUiStatePatch): ShellUiStatePatchKey[] {
  return SHELL_UI_STATE_PATCH_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(patch, key));
}

function deriveShellUnread(shell: ShellSessionSummary): ShellSessionSummary {
  if (shell.latestSeq === undefined || shell.latestSeq === null || shell.lastSeenSeq === undefined || shell.lastSeenSeq === null) {
    return shell;
  }
  return { ...shell, unread: shell.latestSeq > shell.lastSeenSeq };
}

export function applyShellUiStatePatch(shell: ShellSessionSummary, patch: ShellUiStatePatch): ShellSessionSummary {
  return deriveShellUnread({ ...shell, ...patch });
}

function snapshotShellUiStatePatchValue(
  previousValues: ShellUiStatePatch,
  shell: ShellSessionSummary,
  key: ShellUiStatePatchKey,
): void {
  switch (key) {
    case "placement":
      previousValues.placement = shell.placement;
      return;
    case "lastSeenSeq":
      previousValues.lastSeenSeq = shell.lastSeenSeq;
      return;
    default: {
      const unhandledKey: never = key;
      throw new Error(`Unhandled shell UI state patch key: ${String(unhandledKey)}`);
    }
  }
}

export function snapshotShellUiStatePatch(shell: ShellSessionSummary, patch: ShellUiStatePatch): ShellUiStatePatch {
  const previousValues: ShellUiStatePatch = {};
  for (const key of getShellUiStatePatchKeys(patch)) {
    snapshotShellUiStatePatchValue(previousValues, shell, key);
  }
  return previousValues;
}

function rollbackShellUiStatePatchValue(
  shell: ShellSessionSummary,
  patch: ShellUiStatePatch,
  previousValues: ShellUiStatePatch,
  key: ShellUiStatePatchKey,
): ShellSessionSummary {
  switch (key) {
    case "placement":
      return Object.is(shell.placement, patch.placement)
        ? { ...shell, placement: previousValues.placement }
        : shell;
    case "lastSeenSeq":
      return Object.is(shell.lastSeenSeq, patch.lastSeenSeq)
        ? { ...shell, lastSeenSeq: previousValues.lastSeenSeq }
        : shell;
    default: {
      const unhandledKey: never = key;
      throw new Error(`Unhandled shell UI state patch key: ${String(unhandledKey)}`);
    }
  }
}

export function rollbackShellUiStatePatch(
  shell: ShellSessionSummary,
  patch: ShellUiStatePatch,
  previousValues: ShellUiStatePatch,
): ShellSessionSummary {
  let next = shell;
  for (const key of getShellUiStatePatchKeys(patch)) {
    next = rollbackShellUiStatePatchValue(next, patch, previousValues, key);
  }
  return deriveShellUnread(next);
}

export function applyShellRefreshSuccess(
  state: ShellRefreshState,
  nextShells: ShellSessionSummary[],
  authoritative: boolean,
): ShellRefreshState {
  return {
    shells: shellSessionsEqual(state.shells, nextShells) ? state.shells : nextShells,
    authoritative,
    stale: false,
    error: null,
  };
}

export function applyShellRefreshFailure(
  state: ShellRefreshState,
  error: string,
): ShellRefreshState {
  return {
    ...state,
    stale: state.shells.length > 0,
    error,
  };
}

export function applyShellRefreshSilentFailure(state: ShellRefreshState): ShellRefreshState {
  return {
    ...state,
    stale: state.shells.length > 0,
  };
}
