import type { MatrixDB } from "./db.js";
import { createIpcServer } from "./ipc-server.js";
import { getCoreAgents, loadCustomAgents } from "./agents.js";
import { buildSystemPrompt } from "./prompt.js";
import {
  safetyGuardHook,
  updateStateHook,
  logActivityHook,
  createGitSnapshotHook,
  persistSessionHook,
  onSubagentComplete,
  notifyShellHook,
  preCompactHook,
} from "./hooks.js";
import { createProtectedFilesHook } from "./evolution.js";

const IPC_TOOL_NAMES = [
  "mcp__matrix-os-ipc__list_tasks",
  "mcp__matrix-os-ipc__create_task",
  "mcp__matrix-os-ipc__claim_task",
  "mcp__matrix-os-ipc__complete_task",
  "mcp__matrix-os-ipc__fail_task",
  "mcp__matrix-os-ipc__send_message",
  "mcp__matrix-os-ipc__read_messages",
  "mcp__matrix-os-ipc__read_state",
];

export interface KernelConfig {
  db: MatrixDB;
  homePath: string;
  sessionId?: string;
  model?: string;
  effort?: string;
  maxTurns?: number;
}

export function kernelOptions(config: KernelConfig) {
  const { db, homePath, sessionId } = config;

  const ipcServer = createIpcServer(db, homePath);
  const coreAgents = getCoreAgents(homePath);
  const customAgents = loadCustomAgents(`${homePath}/agents/custom`, homePath);
  const agents = { ...coreAgents, ...customAgents };
  const systemPrompt = buildSystemPrompt(homePath);
  const protectedFilesHook = createProtectedFilesHook(homePath);
  const gitSnapshotHook = createGitSnapshotHook(homePath);

  return {
    model: config.model ?? "claude-opus-4-6",
    systemPrompt,
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    mcpServers: { "matrix-os-ipc": ipcServer },
    agents,
    allowedTools: [
      "Read",
      "Write",
      "Edit",
      "Bash",
      "Glob",
      "Grep",
      "Task",
      "TaskOutput",
      "WebSearch",
      "WebFetch",
      ...IPC_TOOL_NAMES,
    ],
    maxTurns: config.maxTurns ?? 80,
    thinking: { type: "adaptive" as const },
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash|Write|Edit",
          hooks: [safetyGuardHook],
        },
        {
          matcher: "Write|Edit",
          hooks: [protectedFilesHook],
        },
      ],
      PostToolUse: [
        {
          matcher: "Write|Edit",
          hooks: [updateStateHook, gitSnapshotHook, notifyShellHook],
        },
        {
          matcher: "Bash",
          hooks: [logActivityHook],
        },
      ],
      Stop: [
        {
          matcher: ".*",
          hooks: [persistSessionHook],
        },
      ],
      SubagentStop: [
        {
          matcher: ".*",
          hooks: [onSubagentComplete],
        },
      ],
      PreCompact: [
        {
          matcher: ".*",
          hooks: [preCompactHook],
        },
      ],
    },
    ...(sessionId && { resume: sessionId }),
  };
}
