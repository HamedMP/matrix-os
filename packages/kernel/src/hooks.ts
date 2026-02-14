import { execFileSync } from "node:child_process";

export interface HookInput {
  hook_event_name: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  session_id: string;
}

export interface HookOutput {
  continue?: boolean;
  stopReason?: string;
  suppressOutput?: boolean;
  systemMessage?: string;
  hookSpecificOutput?: {
    permissionDecision?: "allow" | "deny" | "ask";
    updatedInput?: unknown;
    hookEventName?: string;
  };
}

const DANGEROUS_PATTERNS = [
  /rm\s+(-\w+\s+)*-r\s*f?\s*[/"'~]/,
  /rm\s+(-\w+\s+)*-f\s*r?\s*[/"'~]/,
  /rm\s+-rf\s/,
  /mkfs\./,
  /dd\s+if=/,
  />\s*\/dev\/sd/,
];

const PROTECTED_PATHS = [
  "/etc/",
  "/usr/",
  "/bin/",
  "/sbin/",
  "/var/",
  "/System/",
  "/Library/",
];

export async function safetyGuardHook(input: HookInput): Promise<HookOutput> {
  const toolInput = input.tool_input as Record<string, unknown> | undefined;

  if (input.tool_name === "Bash" && toolInput?.command) {
    const cmd = String(toolInput.command);
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(cmd)) {
        return {
          hookSpecificOutput: { permissionDecision: "deny" },
          systemMessage: `Blocked dangerous command: ${cmd}`,
        };
      }
    }
  }

  if (
    (input.tool_name === "Write" || input.tool_name === "Edit") &&
    toolInput?.file_path
  ) {
    const path = String(toolInput.file_path);
    for (const protected_ of PROTECTED_PATHS) {
      if (path.startsWith(protected_)) {
        return {
          hookSpecificOutput: { permissionDecision: "deny" },
          systemMessage: `Blocked write to protected path: ${path}`,
        };
      }
    }
  }

  return {};
}

export async function updateStateHook(input: HookInput): Promise<HookOutput> {
  // In full implementation: update modules.json and state.md via Drizzle
  // For now, return a valid hook response acknowledging the event
  return {
    hookSpecificOutput: {
      hookEventName: input.hook_event_name,
    },
  };
}

export async function logActivityHook(input: HookInput): Promise<HookOutput> {
  // In full implementation: append to activity.log
  // Format: [timestamp] [agent] [tool] description
  return {};
}

export function createGitSnapshotHook(
  homePath: string,
): (input: HookInput) => Promise<HookOutput> {
  return async (input: HookInput): Promise<HookOutput> => {
    if (input.tool_name !== "Write" && input.tool_name !== "Edit") {
      return {};
    }

    try {
      const status = execFileSync("git", ["status", "--porcelain"], {
        cwd: homePath,
        encoding: "utf-8",
      }).trim();

      if (!status) return {};

      execFileSync("git", ["add", "-A"], { cwd: homePath, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "snapshot: pre-mutation"], {
        cwd: homePath,
        stdio: "ignore",
      });
    } catch {
      // Not a git repo or nothing to commit -- silently continue
    }

    return {};
  };
}

export async function persistSessionHook(
  input: HookInput,
): Promise<HookOutput> {
  // In full implementation: save session ID to ~/system/session.json on Stop
  return {};
}

export async function onSubagentComplete(
  input: HookInput,
): Promise<HookOutput> {
  // In full implementation: read task output from SQLite, update state
  return {};
}

export async function notifyShellHook(input: HookInput): Promise<HookOutput> {
  // In full implementation: push file change event to shell via WebSocket
  return {};
}

export async function preCompactHook(input: HookInput): Promise<HookOutput> {
  // In full implementation: write state snapshot to ~/system/state.md
  // before compaction so summarized context includes pointer to full state
  return {};
}
