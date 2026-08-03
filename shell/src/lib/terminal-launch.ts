export type TerminalLaunchAction =
  | "claude-login"
  | "codex-login"
  | "github-ssh-login"
  | "hermes-install"
  | "hermes-model"
  | "openclaw-install"
  | "openclaw-model-auth"
  | "t3-connect";

export interface TerminalLaunchConfig {
  action: TerminalLaunchAction;
  label: string;
  command: string;
  claudeMode?: boolean;
}

// Replace with the first official T3 release containing PR #5115 before this leaves preview.
const T3_PREVIEW_PACKAGE =
  "https://github.com/HamedMP/t3code/releases/download/matrix-preview-pr-5115-662e50904/t3-pr5115-662e50904.tgz";
const DEFAULT_MATRIX_APP_ORIGIN = "https://app.matrix-os.com";
const T3_PUBLIC_ORIGIN_PLACEHOLDER = "__MATRIX_T3_PUBLIC_ORIGIN__";

function getT3PublicOrigin(): string {
  if (typeof window !== "undefined") {
    const browserUrl = new URL(window.location.href);
    if (browserUrl.protocol === "http:" || browserUrl.protocol === "https:") {
      return browserUrl.origin;
    }
  }

  const configuredUrl = process.env.NEXT_PUBLIC_MATRIX_APP_URL;
  if (configuredUrl && URL.canParse(configuredUrl)) {
    const parsed = new URL(configuredUrl);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.origin;
  }
  return DEFAULT_MATRIX_APP_ORIGIN;
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
  "hermes-model": {
    action: "hermes-model",
    label: "Hermes provider setup",
    command: "hermes model",
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
  "t3-connect": {
    action: "t3-connect",
    label: "Set up T3 Code",
    command: [
      'export MATRIX_NODE_PREFIX="${MATRIX_NODE_PREFIX:-/opt/matrix/runtime/node}"',
      'export PATH="$MATRIX_NODE_PREFIX/bin:$PATH"',
      'export MATRIX_T3_HOME="${MATRIX_HOME:-$HOME}/system/t3code"',
      'mkdir -p "$MATRIX_T3_HOME"',
      `export MATRIX_T3_PACKAGE="${T3_PREVIEW_PACKAGE}"`,
      'case "${MATRIX_HANDLE:-}" in ""|*[!a-z0-9-]*) printf \'Matrix computer handle is unavailable or invalid.\\n\'; exit 1 ;; esac',
      'if [ "${#MATRIX_HANDLE}" -lt 2 ] || [ "${#MATRIX_HANDLE}" -gt 63 ]; then printf \'Matrix computer handle is unavailable or invalid.\\n\'; exit 1; fi',
      `export MATRIX_T3_PUBLIC_BASE_URL="${T3_PUBLIC_ORIGIN_PLACEHOLDER}/vm/$MATRIX_HANDLE/api/integrations/t3/"`,
      "printf 'T3 Code wants to install the pinned CLI build paired with this Matrix preview and expose its local server through this Matrix OS computer.\\nNo T3 account or Matrix credentials are required. Anyone with the one-time pairing link can connect, so keep it private. Continue? [y/N] '",
      "read -r MATRIX_T3_CONFIRM",
      'case "$MATRIX_T3_CONFIRM" in [yY]|[yY][eE][sS]) printf \'\\nChecking for an existing T3 Code server.\\n\\n\'; if npx --yes "$MATRIX_T3_PACKAGE" pair --pairing-base-url "$MATRIX_T3_PUBLIC_BASE_URL" --base-dir "$MATRIX_T3_HOME"; then printf \'\\nA fresh pairing link was created for the running server.\\n\'; else printf \'\\nStarting T3 Code locally. Scan or paste the pairing link shown below in the T3 Code app. Keep this Terminal session running.\\n\\n\'; exec npx --yes "$MATRIX_T3_PACKAGE" serve --host 127.0.0.1 --port 3773 --pairing-base-url "$MATRIX_T3_PUBLIC_BASE_URL" --base-dir "$MATRIX_T3_HOME"; fi ;; *) printf \'T3 Code setup canceled.\\n\' ;; esac',
    ].join(" && "),
  },
};

function materializeTerminalLaunchConfig(config: TerminalLaunchConfig): TerminalLaunchConfig {
  if (config.action !== "t3-connect") return config;
  return {
    ...config,
    command: config.command.replace(T3_PUBLIC_ORIGIN_PLACEHOLDER, getT3PublicOrigin()),
  };
}

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
  action: TerminalLaunchAction;
  targetId?: string;
}

function isTerminalLaunchAction(value: unknown): value is TerminalLaunchAction {
  return typeof value === "string" && Object.hasOwn(TERMINAL_ACTIONS, value);
}

export function terminalLaunchConfig(action: TerminalLaunchAction): TerminalLaunchConfig {
  return materializeTerminalLaunchConfig(TERMINAL_ACTIONS[action]);
}

function parseTerminalLaunchAction(value: string | null): TerminalLaunchConfig | null {
  if (!isTerminalLaunchAction(value)) return null;
  return terminalLaunchConfig(value);
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
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
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

export function enqueueTerminalLaunch(action: TerminalLaunchAction, targetId?: string): void {
  if (!isTerminalLaunchAction(action)) return;
  writeLaunchQueue([...readLaunchQueue(), { action, targetId }]);
  window.dispatchEvent(new CustomEvent(TERMINAL_LAUNCH_EVENT, { detail: { targetId } }));
}

export function enqueueTerminalLaunchAction(
  action: TerminalLaunchAction,
  targetId?: string,
): boolean {
  if (!isTerminalLaunchAction(action)) return false;
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
  return matched.map((launch) => terminalLaunchConfig(launch.action));
}
