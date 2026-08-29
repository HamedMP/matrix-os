import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { shouldRequireApproval, type ApprovalPolicy } from "./approval.js";
import { createAuditLogger, type AuditLogger } from "./audit.js";

export interface HookInput {
  hook_event_name: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  session_id: string;
  agent_id?: string;
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
    } catch (err: unknown) {
      console.warn("[hooks] Pre-mutation snapshot skipped:", err instanceof Error ? err.message : String(err));
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

const FILE_MUTATION_TOOLS = new Set(["Write", "Edit"]);

export function createFileAuditHook(
  logDir: string,
): (input: HookInput) => Promise<HookOutput> {
  const auditLogger = createAuditLogger(logDir);

  return async (input: HookInput): Promise<HookOutput> => {
    if (input.hook_event_name !== "PostToolUse") return {};
    if (!input.tool_name || !FILE_MUTATION_TOOLS.has(input.tool_name)) return {};

    const toolInput = input.tool_input as Record<string, unknown> | undefined;
    if (!toolInput?.file_path) return {};

    const filePath = String(toolInput.file_path);
    const content = toolInput.content ?? toolInput.new_string ?? "";
    const sizeBytes = typeof content === "string" ? Buffer.byteLength(content) : 0;

    auditLogger.log({
      op: "write",
      path: filePath,
      sizeBytes,
      actor: "kernel",
    });

    return {};
  };
}

export type RequestApprovalFn = (toolName: string, args: unknown) => Promise<boolean>;

export function createApprovalHook(
  policy: ApprovalPolicy,
  requestApproval: RequestApprovalFn,
): (input: HookInput) => Promise<HookOutput> {
  return async (input: HookInput): Promise<HookOutput> => {
    if (!input.tool_name) return {};

    const needsApproval = shouldRequireApproval(
      input.tool_name,
      input.tool_input,
      policy,
    );

    if (!needsApproval) return {};

    try {
      const approved = await requestApproval(input.tool_name, input.tool_input);
      if (approved) return {};

      return {
        hookSpecificOutput: { permissionDecision: "deny" },
        systemMessage: `User denied approval for ${input.tool_name}`,
      };
    } catch (err: unknown) {
      console.warn("[hooks] Approval failed:", err instanceof Error ? err.message : String(err));
      return {
        hookSpecificOutput: { permissionDecision: "deny" },
        systemMessage: `Approval timed out for ${input.tool_name} -- auto-denied`,
      };
    }
  };
}

export const MANAGED_WRITE_ACTIONS = new Set([
  "gmail/send_email",
  "google_calendar/create_event",
  "google_calendar/update_event",
  "google_drive/upload_file",
  "google_drive/share_file",
  "github/create_issue",
  "linear/create_issue",
  "linear/update_issue",
  "linear/comment_issue",
  "linear/create_workflow_state",
  "slack/send_message",
  "slack/react",
  "discord/send_message",
  "google_docs/create_document",
  "google_docs/batch_update_document",
  "notion/create_page",
  "notion/update_page",
  "notion/append_blocks",
  "figma/post_comment",
  "jira/create_issue",
  "jira/update_issue",
  "jira/add_comment",
]);

interface CustomMcpProjectionFile {
  servers?: Array<{
    id: string;
    name: string;
    enabled: boolean;
    tools: Array<{ name: string; enabled: boolean; approval: "always_ask" | "allow" }>;
  }>;
}

/** Native approval gate for managed integration writes and Custom MCP calls. */
export function createIntegrationApprovalHook(
  homePath: string,
  requestApproval: RequestApprovalFn,
  customAgentMcpAllowlists: Readonly<Record<string, readonly string[]>> = {},
): (input: HookInput) => Promise<HookOutput> {
  return async (input) => {
    if (input.tool_name === "mcp__matrix-os-ipc__call_service") {
      const args = input.tool_input as { service?: unknown; action?: unknown } | undefined;
      const key = `${String(args?.service ?? "")}/${String(args?.action ?? "")}`;
      if (!MANAGED_WRITE_ACTIONS.has(key)) return {};
      return (await requestApproval(input.tool_name, input.tool_input))
        ? {}
        : {
            hookSpecificOutput: { permissionDecision: "deny" },
            systemMessage: `User denied approval for ${key}`,
          };
    }
    if (input.tool_name !== "mcp__matrix-os-ipc__call_custom_mcp_tool") return {};
    try {
      const args = input.tool_input as { server_id?: unknown; tool?: unknown } | undefined;
      const raw = await readFile(join(homePath, "system", "mcp-servers.json"), "utf8");
      const projection = JSON.parse(raw) as CustomMcpProjectionFile;
      const server = projection.servers?.find((candidate) => candidate.id === args?.server_id);
      const tool = server?.tools.find((candidate) => candidate.name === args?.tool);
      if (!server?.enabled || !tool?.enabled) {
        return {
          hookSpecificOutput: { permissionDecision: "deny" },
          systemMessage: "Custom MCP access is not enabled in the local enforcement projection.",
        };
      }
      if (input.agent_id) {
        const grants = customAgentMcpAllowlists[input.agent_id] ?? [];
        if (!grants.includes(server.id) && !grants.includes(server.name)) {
          return {
            hookSpecificOutput: { permissionDecision: "deny" },
            systemMessage: "This custom subagent does not name the MCP server in its mcp frontmatter.",
          };
        }
      }
      if (tool.approval === "allow") return {};
      return (await requestApproval(input.tool_name, input.tool_input))
        ? {}
        : {
            hookSpecificOutput: { permissionDecision: "deny" },
            systemMessage: `User denied approval for ${server.name}/${tool.name}`,
          };
    } catch (error: unknown) {
      console.warn("[hooks] Custom MCP approval failed closed:", error instanceof Error ? error.message : String(error));
      return {
        hookSpecificOutput: { permissionDecision: "deny" },
        systemMessage: "Custom MCP approval state is unavailable.",
      };
    }
  };
}
