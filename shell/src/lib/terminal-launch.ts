export type TerminalLaunchAction = "claude-login" | "codex-login" | "github-ssh-login";

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
    label: "GitHub SSH login",
    command: "printf 'Matrix uses GitHub over SSH for coding projects.\\nChoose GitHub.com, SSH, and browser login when prompted.\\n\\n' && gh auth login --hostname github.com --git-protocol ssh --web",
  },
};

const TERMINAL_LAUNCH_QUEUE_KEY = "matrix:terminal-launch-queue";
export const TERMINAL_SETUP_WINDOW_PATH = "__terminal__:setup";
export const TERMINAL_LAUNCH_EVENT = "matrix:terminal-launch";

interface QueuedTerminalLaunch {
  path: string;
  targetId?: string;
}

export function createTerminalLaunchPath(action: TerminalLaunchAction): string {
  return `__terminal__:setup-${action}-${Date.now().toString(36)}`;
}

export function parseTerminalLaunchPath(path: string): TerminalLaunchConfig | null {
  if (!path.startsWith("__terminal__:setup-")) return null;
  const match = path.match(/^__terminal__:setup-(claude-login|codex-login|github-ssh-login)(?:-[A-Za-z0-9]+)?$/);
  if (!match) return null;
  return TERMINAL_ACTIONS[match[1] as TerminalLaunchAction];
}

function readLaunchQueue(): QueuedTerminalLaunch[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.sessionStorage.getItem(TERMINAL_LAUNCH_QUEUE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .flatMap((item): QueuedTerminalLaunch[] => {
        if (typeof item === "string") return [{ path: item }];
        if (
          item &&
          typeof item === "object" &&
          typeof (item as { path?: unknown }).path === "string"
        ) {
          const targetId = (item as { targetId?: unknown }).targetId;
          return [{
            path: (item as { path: string }).path,
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

export function enqueueTerminalLaunch(path: string, targetId?: string): void {
  if (!parseTerminalLaunchPath(path)) return;
  writeLaunchQueue([...readLaunchQueue(), { path, targetId }]);
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
  return matched.map((launch) => parseTerminalLaunchPath(launch.path)).filter((config): config is TerminalLaunchConfig => config !== null);
}
