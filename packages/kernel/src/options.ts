import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
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

const BROWSER_TOOL_NAMES = [
  "mcp__matrix-os-browser__browse_web",
];

function loadBrowserConfig(homePath: string): { enabled: boolean; headless: boolean; timeout: number } | null {
  try {
    const configPath = join(homePath, "system", "config.json");
    if (!existsSync(configPath)) return null;
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    if (!config.browser?.enabled) return null;
    return {
      enabled: true,
      headless: config.browser.headless ?? true,
      timeout: config.browser.timeout ?? 30000,
    };
  } catch {
    return null;
  }
}

function tryCreateBrowserServer(homePath: string, browserConfig: { headless: boolean; timeout: number }) {
  try {
    const { createBrowserMcpServer } = require("@matrix-os/mcp-browser/server");
    return createBrowserMcpServer({ homePath, ...browserConfig });
  } catch {
    return null;
  }
}

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
  const systemPrompt = buildSystemPrompt(homePath, db);
  const protectedFilesHook = createProtectedFilesHook(homePath);
  const gitSnapshotHook = createGitSnapshotHook(homePath);

  const mcpServers: Record<string, unknown> = { "matrix-os-ipc": ipcServer };
  const browserToolNames: string[] = [];

  const browserConfig = loadBrowserConfig(homePath);
  if (browserConfig) {
    const browserServer = tryCreateBrowserServer(homePath, browserConfig);
    if (browserServer) {
      mcpServers["matrix-os-browser"] = browserServer;
      browserToolNames.push(...BROWSER_TOOL_NAMES);
    }
  }

  return {
    model: config.model ?? "claude-opus-4-6",
    systemPrompt,
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    mcpServers,
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
      ...browserToolNames,
    ],
    maxTurns: config.maxTurns ?? 80,
    thinking: { type: "adaptive" as const },
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash|Write|Edit",
          hooks: [safetyGuardHook as (...args: unknown[]) => Promise<unknown>],
        },
        {
          matcher: "Write|Edit",
          hooks: [protectedFilesHook as (...args: unknown[]) => Promise<unknown>],
        },
      ],
      PostToolUse: [
        {
          matcher: "Write|Edit",
          hooks: [updateStateHook, gitSnapshotHook, notifyShellHook].map(
            (h) => h as (...args: unknown[]) => Promise<unknown>,
          ),
        },
        {
          matcher: "Bash",
          hooks: [logActivityHook as (...args: unknown[]) => Promise<unknown>],
        },
      ],
      Stop: [
        {
          matcher: ".*",
          hooks: [persistSessionHook as (...args: unknown[]) => Promise<unknown>],
        },
      ],
      SubagentStop: [
        {
          matcher: ".*",
          hooks: [onSubagentComplete as (...args: unknown[]) => Promise<unknown>],
        },
      ],
      PreCompact: [
        {
          matcher: ".*",
          hooks: [preCompactHook as (...args: unknown[]) => Promise<unknown>],
        },
      ],
    } as Record<string, { matcher: string; hooks: ((...args: unknown[]) => Promise<unknown>)[] }[]>,
    ...(sessionId && { resume: sessionId }),
  };
}
