export type TerminalLaunchAction =
  | "claude-login"
  | "codex-login"
  | "github-ssh-login"
  | "hermes-install"
  | "openclaw-install"
  | "openclaw-model-auth";

export interface TerminalLaunchConfig {
  action: TerminalLaunchAction;
  label: string;
  command: string;
  claudeMode?: boolean;
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
  "openclaw-install": {
    action: "openclaw-install",
    label: "Install OpenClaw",
    command: "/opt/matrix/bin/matrix-agent-runtime-control install openclaw",
  },
  "openclaw-model-auth": {
    action: "openclaw-model-auth",
    label: "OpenClaw provider setup",
    command: "openclaw models auth add",
  },
};

const TERMINAL_LAUNCH_QUEUE_KEY = "matrix:terminal-launch-queue";
export const TERMINAL_SETUP_WINDOW_PATH = "__terminal__";
export const TERMINAL_LAUNCH_EVENT = "matrix:terminal-launch";

interface QueuedTerminalLaunch {
  action: TerminalLaunchAction;
  targetId?: string;
}

function isTerminalLaunchAction(value: unknown): value is TerminalLaunchAction {
  return typeof value === "string" && Object.hasOwn(TERMINAL_ACTIONS, value);
}

export function terminalLaunchConfig(action: TerminalLaunchAction): TerminalLaunchConfig {
  return TERMINAL_ACTIONS[action];
}

function readLaunchQueue(): QueuedTerminalLaunch[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.sessionStorage.getItem(TERMINAL_LAUNCH_QUEUE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .flatMap((item): QueuedTerminalLaunch[] => {
        if (
          item &&
          typeof item === "object" &&
          isTerminalLaunchAction((item as { action?: unknown }).action)
        ) {
          const targetId = (item as { targetId?: unknown }).targetId;
          return [{
            action: (item as { action: TerminalLaunchAction }).action,
            targetId: typeof targetId === "string" ? targetId : undefined,
          }];
        }
        return [];
      })
      .slice(-8);
  } catch (err: unknown) {
    console.warn("[terminal-launch] failed to read launch queue:", err instanceof Error ? err.message : String(err));
    return [];
  }
}

function writeLaunchQueue(launches: QueuedTerminalLaunch[]) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(TERMINAL_LAUNCH_QUEUE_KEY, JSON.stringify(launches.slice(-8)));
  } catch (err: unknown) {
    console.warn("[terminal-launch] failed to write launch queue:", err instanceof Error ? err.message : String(err));
  }
}

export function enqueueTerminalLaunch(action: TerminalLaunchAction, targetId?: string): void {
  if (!isTerminalLaunchAction(action)) return;
  writeLaunchQueue([...readLaunchQueue(), { action, targetId }]);
  window.dispatchEvent(new CustomEvent(TERMINAL_LAUNCH_EVENT, { detail: { targetId } }));
}

export function drainTerminalLaunchQueue(targetId?: string): TerminalLaunchConfig[] {
  const launches = readLaunchQueue();
  const matched: QueuedTerminalLaunch[] = [];
  const remaining: QueuedTerminalLaunch[] = [];
  for (const launch of launches) {
    if (!targetId || launch.targetId === targetId || !launch.targetId) matched.push(launch);
    else remaining.push(launch);
  }
  writeLaunchQueue(remaining);
  return matched.map((launch) => terminalLaunchConfig(launch.action));
}
