export type TerminalLaunchAction =
  | "claude-login"
  | "codex-login"
  | "github-ssh-login"
  | "hermes-install"
  | "hermes-restart"
  | "openclaw-install"
  | "openclaw-restart"
  | "openclaw-model-auth";

export interface TerminalLaunchConfig {
  action: TerminalLaunchAction;
  tabId?: string;
  label: string;
  command: string;
  claudeMode?: boolean;
  targetId?: string;
  retryCount?: number;
}

const TERMINAL_ACTIONS: Record<TerminalLaunchAction, TerminalLaunchConfig> = {
  "claude-login": {
    action: "claude-login",
    label: "Claude login",
    command: "claude",
    claudeMode: true,
  },
  "codex-login": {
    action: "codex-login",
    label: "Codex login",
    command: "codex",
  },
  "github-ssh-login": {
    action: "github-ssh-login",
    label: "GitHub browser login",
    command: "printf 'Matrix authenticates GitHub separately from SSH keys.\\nUse browser login here. Do not upload local private keys; secure repository SSH uses a Matrix-managed key inside the runtime.\\n\\n' && gh auth login --hostname github.com --web",
  },
  "hermes-install": {
    action: "hermes-install",
    label: "Install Hermes",
    command: "/opt/matrix/bin/matrix-agent-runtime-control install hermes",
  },
  "hermes-restart": {
    action: "hermes-restart",
    label: "Restart Hermes",
    command: "/opt/matrix/bin/matrix-agent-runtime-control switch hermes",
  },
  "openclaw-install": {
    action: "openclaw-install",
    label: "Install OpenClaw",
    command: "/opt/matrix/bin/matrix-agent-runtime-control install openclaw",
  },
  "openclaw-restart": {
    action: "openclaw-restart",
    label: "Restart OpenClaw",
    command: "/opt/matrix/bin/matrix-agent-runtime-control switch openclaw",
  },
  "openclaw-model-auth": {
    action: "openclaw-model-auth",
    label: "OpenClaw provider setup",
    command: "openclaw models auth add",
  },
};

const TERMINAL_LAUNCH_QUEUE_KEY = "matrix:terminal-launch-queue";
export const TERMINAL_LAUNCH_EVENT = "matrix:terminal-launch";
const TERMINAL_LAUNCH_QUEUE_LIMIT = 8;

interface QueuedTerminalLaunch {
  action: TerminalLaunchAction;
  tabId?: string;
  targetId?: string;
  retryCount?: number;
}

interface LaunchQueueRead {
  launches: QueuedTerminalLaunch[];
  complete: boolean;
}

const MAX_AUTOMATIC_LAUNCH_RETRIES = 3;
const RELEASE_RETRY_DELAY_MS = 100;
const MAX_RELEASE_RETRY_DELAY_MS = 1_000;
let volatileLaunchQueue: QueuedTerminalLaunch[] | null = null;
let volatileLaunchQueueComplete = true;
let pendingReleasedTargetIds: string[] = [];
let pendingReleaseRetryTimer: number | undefined;
let pendingReleaseRetryDelayMs = RELEASE_RETRY_DELAY_MS;

function dispatchTerminalLaunchWake(): void {
  window.dispatchEvent(new CustomEvent(TERMINAL_LAUNCH_EVENT));
}

function schedulePendingReleaseRetry(): void {
  if (
    typeof window === "undefined"
    || pendingReleasedTargetIds.length === 0
    || pendingReleaseRetryTimer !== undefined
  ) return;
  pendingReleaseRetryTimer = window.setTimeout(() => {
    pendingReleaseRetryTimer = undefined;
    if (pendingReleasedTargetIds.length === 0) return;
    pendingReleaseRetryDelayMs = Math.min(
      pendingReleaseRetryDelayMs * 2,
      MAX_RELEASE_RETRY_DELAY_MS,
    );
    dispatchTerminalLaunchWake();
    schedulePendingReleaseRetry();
  }, pendingReleaseRetryDelayMs);
}

function clearPendingReleaseRetry(): void {
  if (pendingReleaseRetryTimer !== undefined) window.clearTimeout(pendingReleaseRetryTimer);
  pendingReleaseRetryTimer = undefined;
  pendingReleaseRetryDelayMs = RELEASE_RETRY_DELAY_MS;
}

function isTerminalLaunchAction(value: unknown): value is TerminalLaunchAction {
  return typeof value === "string" && Object.hasOwn(TERMINAL_ACTIONS, value);
}

function terminalTabId(): string {
  return `tt_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
}

function isTerminalTabId(value: unknown): value is string {
  return typeof value === "string" && /^tt_[0-9a-f]{32}$/.test(value);
}

export function terminalLaunchConfig(action: TerminalLaunchAction): TerminalLaunchConfig {
  return TERMINAL_ACTIONS[action];
}

function sanitizeLaunchQueue(value: unknown): QueuedTerminalLaunch[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((item): QueuedTerminalLaunch[] => {
      if (
        item &&
        typeof item === "object" &&
        isTerminalLaunchAction((item as { action?: unknown }).action)
      ) {
        const targetId = (item as { targetId?: unknown }).targetId;
        const tabId = (item as { tabId?: unknown }).tabId;
        const retryCount = (item as { retryCount?: unknown }).retryCount;
        return [{
          action: (item as { action: TerminalLaunchAction }).action,
          tabId: isTerminalTabId(tabId) ? tabId : undefined,
          targetId: typeof targetId === "string" ? targetId : undefined,
          retryCount: Number.isInteger(retryCount)
            && Number(retryCount) >= 0
            && Number(retryCount) <= MAX_AUTOMATIC_LAUNCH_RETRIES
            ? Number(retryCount)
            : undefined,
        }];
      }
      return [];
    })
    .slice(-TERMINAL_LAUNCH_QUEUE_LIMIT);
}

function readStoredLaunchQueue(): LaunchQueueRead {
  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(TERMINAL_LAUNCH_QUEUE_KEY);
  } catch (err: unknown) {
    console.warn("[terminal-launch] failed to read launch queue:", err instanceof Error ? err.message : String(err));
    return { launches: [], complete: false };
  }
  if (!raw) return { launches: [], complete: true };
  try {
    return { launches: sanitizeLaunchQueue(JSON.parse(raw)), complete: true };
  } catch (err: unknown) {
    console.warn("[terminal-launch] failed to parse launch queue:", err instanceof Error ? err.message : String(err));
    return { launches: [], complete: true };
  }
}

function readLaunchQueue(): LaunchQueueRead {
  if (typeof window === "undefined") return { launches: [], complete: true };
  let current: LaunchQueueRead;
  if (volatileLaunchQueue === null) current = readStoredLaunchQueue();
  else if (volatileLaunchQueueComplete) {
    current = { launches: volatileLaunchQueue, complete: true };
  } else {
    const stored = readStoredLaunchQueue();
    if (!stored.complete) return { launches: volatileLaunchQueue, complete: false };
    volatileLaunchQueue = sanitizeLaunchQueue([...stored.launches, ...volatileLaunchQueue]);
    volatileLaunchQueueComplete = true;
    current = { launches: volatileLaunchQueue, complete: true };
  }
  if (!current.complete || pendingReleasedTargetIds.length === 0) return current;
  const released = pendingReleasedTargetIds;
  pendingReleasedTargetIds = [];
  clearPendingReleaseRetry();
  queueMicrotask(dispatchTerminalLaunchWake);
  return {
    complete: true,
    launches: current.launches.map((launch) => (
      launch.targetId && released.includes(launch.targetId)
        ? { ...launch, targetId: undefined }
        : launch
    )),
  };
}

function writeLaunchQueue(launches: QueuedTerminalLaunch[], complete = true) {
  if (typeof window === "undefined") return;
  const boundedQueue = launches.slice(-TERMINAL_LAUNCH_QUEUE_LIMIT);
  if (!complete) {
    // This is only the volatile overlay; overwriting storage would erase the
    // unread authoritative queue. Merge after a later successful read.
    volatileLaunchQueue = boundedQueue;
    volatileLaunchQueueComplete = false;
    return;
  }
  try {
    window.sessionStorage.setItem(TERMINAL_LAUNCH_QUEUE_KEY, JSON.stringify(boundedQueue));
    volatileLaunchQueue = null;
    volatileLaunchQueueComplete = true;
  } catch (err: unknown) {
    console.warn("[terminal-launch] failed to write launch queue:", err instanceof Error ? err.message : String(err));
    // Preserve the bounded queue for the lifetime of this shell page when Web
    // Storage is blocked so a drained command can still be claimed by another
    // mounted terminal.
    volatileLaunchQueue = boundedQueue;
    volatileLaunchQueueComplete = true;
  }
}

export function requeueTerminalLaunch(action: TerminalLaunchAction, targetId?: string): void {
  if (!isTerminalLaunchAction(action)) return;
  const current = readLaunchQueue();
  writeLaunchQueue([...current.launches, { action, targetId, tabId: terminalTabId() }], current.complete);
}

export function requeueFailedTerminalLaunch(
  action: TerminalLaunchAction,
  retryCount = 0,
  tabId?: string,
): void {
  // The terminal that owned a targeted launch may have closed while tab
  // creation was in flight. Drop that stale identity so another terminal can
  // claim the retry on its next queue drain.
  const boundedRetryCount = Number.isInteger(retryCount)
    ? Math.min(Math.max(retryCount, 0), MAX_AUTOMATIC_LAUNCH_RETRIES)
    : 0;
  const nextRetryCount = Math.min(boundedRetryCount + 1, MAX_AUTOMATIC_LAUNCH_RETRIES);
  const current = readLaunchQueue();
  writeLaunchQueue(
    [...current.launches, {
      action,
      retryCount: nextRetryCount,
      tabId: isTerminalTabId(tabId) ? tabId : terminalTabId(),
    }],
    current.complete,
  );
  if (boundedRetryCount < MAX_AUTOMATIC_LAUNCH_RETRIES) {
    queueMicrotask(() => {
      window.dispatchEvent(new CustomEvent(TERMINAL_LAUNCH_EVENT));
    });
  }
}

export function releaseTerminalLaunchTarget(targetId: string): void {
  if (!targetId || targetId.length > 256) return;
  const current = readLaunchQueue();
  if (!current.complete) {
    pendingReleasedTargetIds = [
      ...pendingReleasedTargetIds.filter((candidate) => candidate !== targetId),
      targetId,
    ].slice(-TERMINAL_LAUNCH_QUEUE_LIMIT);
    queueMicrotask(dispatchTerminalLaunchWake);
    schedulePendingReleaseRetry();
    return;
  }
  let changed = false;
  const launches = current.launches.map((launch) => {
    if (launch.targetId !== targetId) return launch;
    changed = true;
    return {
      action: launch.action,
      ...(launch.tabId ? { tabId: launch.tabId } : {}),
      ...(launch.retryCount === undefined ? {} : { retryCount: launch.retryCount }),
    };
  });
  if (!changed) return;
  writeLaunchQueue(launches, current.complete);
  // Let the destroyed terminal remove its listener before waking another
  // mounted terminal to claim the newly untargeted launch.
  queueMicrotask(dispatchTerminalLaunchWake);
}

export function enqueueTerminalLaunch(action: TerminalLaunchAction, targetId?: string): void {
  requeueTerminalLaunch(action, targetId);
  window.dispatchEvent(new CustomEvent(TERMINAL_LAUNCH_EVENT, { detail: { targetId } }));
}

export function drainTerminalLaunchQueue(targetId?: string): TerminalLaunchConfig[] {
  const current = readLaunchQueue();
  const matched: QueuedTerminalLaunch[] = [];
  const remaining: QueuedTerminalLaunch[] = [];
  for (const launch of current.launches) {
    if (!targetId || launch.targetId === targetId || !launch.targetId) matched.push(launch);
    else remaining.push(launch);
  }
  writeLaunchQueue(remaining, current.complete);
  return matched.map((launch) => ({
    ...terminalLaunchConfig(launch.action),
    tabId: launch.tabId ?? terminalTabId(),
    ...(launch.targetId ? { targetId: launch.targetId } : {}),
    ...(launch.retryCount === undefined ? {} : { retryCount: launch.retryCount }),
  }));
}
