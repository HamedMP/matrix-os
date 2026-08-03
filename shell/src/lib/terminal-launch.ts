export type TerminalLaunchAction =
  | "claude-login"
  | "codex-login"
  | "github-ssh-login"
  | "t3-connect";

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
  "t3-connect": {
    action: "t3-connect",
    label: "Set up T3 Code",
    command: [
      'export MATRIX_NODE_PREFIX="${MATRIX_NODE_PREFIX:-/opt/matrix/runtime/node}"',
      'export PATH="$MATRIX_NODE_PREFIX/bin:$PATH"',
      'export MATRIX_T3_HOME="${MATRIX_HOME:-$HOME}/system/t3code"',
      'mkdir -p "$MATRIX_T3_HOME"',
      'case "${MATRIX_HANDLE:-}" in ""|*[!a-z0-9-]*) printf \'Matrix computer handle is unavailable or invalid.\\n\'; exit 1 ;; esac',
      'if [ "${#MATRIX_HANDLE}" -lt 2 ] || [ "${#MATRIX_HANDLE}" -gt 63 ]; then printf \'Matrix computer handle is unavailable or invalid.\\n\'; exit 1; fi',
      'export MATRIX_T3_PUBLIC_BASE_URL="https://app.matrix-os.com/vm/$MATRIX_HANDLE/api/integrations/t3/"',
      "printf 'T3 Code wants to install its pinned official CLI (t3@0.0.32) and expose its local server through this Matrix OS computer.\\nNo T3 account or Matrix credentials are required. Anyone with the one-time pairing link can connect, so keep it private. Continue? [y/N] '",
      "read -r MATRIX_T3_CONFIRM",
      'case "$MATRIX_T3_CONFIRM" in [yY]|[yY][eE][sS]) printf \'\\nChecking for an existing T3 Code server.\\n\\n\'; if npx --yes t3@0.0.32 pair --pairing-base-url "$MATRIX_T3_PUBLIC_BASE_URL" --base-dir "$MATRIX_T3_HOME"; then printf \'\\nA fresh pairing link was created for the running server.\\n\'; else printf \'\\nStarting T3 Code locally. Scan or paste the pairing link shown below in the T3 Code app. Keep this Terminal session running.\\n\\n\'; exec npx --yes t3@0.0.32 serve --host 127.0.0.1 --port 3773 --pairing-base-url "$MATRIX_T3_PUBLIC_BASE_URL" --base-dir "$MATRIX_T3_HOME"; fi ;; *) printf \'T3 Code setup canceled.\\n\' ;; esac',
    ].join(" && "),
  },
};

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function createCanonicalTerminalLaunchCommand(command: string): string {
  return `bash -lc ${shellSingleQuote(command)}`;
}

const TERMINAL_LAUNCH_QUEUE_KEY = "matrix:terminal-launch-queue";
export const TERMINAL_SETUP_WINDOW_PATH = "__terminal__";
export const TERMINAL_LAUNCH_EVENT = "matrix:terminal-launch";

interface QueuedTerminalLaunch {
  path?: string;
  action?: TerminalLaunchAction;
  targetId?: string;
}

export function createTerminalLaunchPath(action: TerminalLaunchAction): string {
  return `__terminal__:setup-${action}-${Date.now().toString(36)}`;
}

export function parseTerminalLaunchPath(path: string): TerminalLaunchConfig | null {
  if (!path.startsWith("__terminal__:setup-")) return null;
  const match = path.match(/^__terminal__:setup-(claude-login|codex-login|github-ssh-login|t3-connect)(?:-[A-Za-z0-9]+)?$/);
  if (!match) return null;
  return TERMINAL_ACTIONS[match[1] as TerminalLaunchAction];
}

function parseTerminalLaunchAction(value: string | null): TerminalLaunchConfig | null {
  if (!value || !Object.hasOwn(TERMINAL_ACTIONS, value)) return null;
  return TERMINAL_ACTIONS[value as TerminalLaunchAction];
}

export function parseTerminalLaunchActionFromSearch(search: string): TerminalLaunchConfig | null {
  const params = new URLSearchParams(search);
  if (
    params.getAll("launch").length !== 1 ||
    params.get("launch") !== TERMINAL_SETUP_WINDOW_PATH ||
    params.getAll("terminal_action").length !== 1
  ) {
    return null;
  }
  return parseTerminalLaunchAction(params.get("terminal_action"));
}

export function consumeTerminalLaunchActionFromLocation(): boolean {
  if (typeof window === "undefined") return false;
  if (!parseTerminalLaunchActionFromSearch(window.location.search)) return false;
  const url = new URL(window.location.href);
  url.searchParams.delete("launch");
  url.searchParams.delete("terminal_action");
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
  return true;
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
          (typeof (item as { path?: unknown }).path === "string" ||
            typeof (item as { action?: unknown }).action === "string")
        ) {
          const path = (item as { path?: unknown }).path;
          const action = parseTerminalLaunchAction(
            typeof (item as { action?: unknown }).action === "string"
              ? (item as { action: string }).action
              : null,
          )?.action;
          if (typeof path !== "string" && !action) return [];
          const targetId = (item as { targetId?: unknown }).targetId;
          return [{
            path: typeof path === "string" ? path : undefined,
            action,
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

function writeLaunchQueue(launches: QueuedTerminalLaunch[]): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.sessionStorage.setItem(TERMINAL_LAUNCH_QUEUE_KEY, JSON.stringify(launches.slice(-8)));
    return true;
  } catch (err: unknown) {
    console.warn("[terminal-launch] failed to write launch queue:", err instanceof Error ? err.message : String(err));
    return false;
  }
}

export function enqueueTerminalLaunch(path: string, targetId?: string): void {
  if (!parseTerminalLaunchPath(path)) return;
  writeLaunchQueue([...readLaunchQueue(), { path, targetId }]);
  window.dispatchEvent(new CustomEvent(TERMINAL_LAUNCH_EVENT, { detail: { targetId } }));
}

export function enqueueTerminalLaunchAction(
  action: TerminalLaunchAction,
  targetId?: string,
): boolean {
  if (!parseTerminalLaunchAction(action)) return false;
  if (!writeLaunchQueue([...readLaunchQueue(), { action, targetId }])) return false;
  window.dispatchEvent(new CustomEvent(TERMINAL_LAUNCH_EVENT, { detail: { targetId } }));
  return true;
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
  return matched
    .map((launch) => (
      launch.action
        ? parseTerminalLaunchAction(launch.action)
        : parseTerminalLaunchPath(launch.path ?? "")
    ))
    .filter((config): config is TerminalLaunchConfig => config !== null);
}
