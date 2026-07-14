import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { MatrixDB } from "./db.js";
import { createIpcServer } from "./ipc-server.js";
import { getCoreAgents, loadCustomAgents } from "./agents.js";
import { buildSystemPrompt } from "./prompt.js";
import { ensureSdkSkillsMirror } from "./skills.js";
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
  "mcp__matrix-os-ipc__app_data",
  "mcp__matrix-os-ipc__load_skill",
  "mcp__matrix-os-ipc__get_persona_suggestions",
  "mcp__matrix-os-ipc__write_setup_plan",
  "mcp__matrix-os-ipc__manage_cron",
  "mcp__matrix-os-ipc__sync_files",
  "mcp__matrix-os-ipc__publish_app",
  "mcp__matrix-os-ipc__fork_app",
  "mcp__matrix-os-ipc__connect_service",
  "mcp__matrix-os-ipc__call_service",
  "mcp__matrix-os-ipc__list_connected_services",
  "mcp__matrix-os-ipc__sync_services",
];

const BROWSER_TOOL_NAMES = [
  "mcp__matrix-os-browser__browser",
];

function loadBrowserConfig(homePath: string): {
  enabled: boolean;
  headless: boolean;
  timeout: number;
  idleTimeout: number;
  defaultProfile: string;
} | null {
  try {
    const configPath = join(homePath, "system", "config.json");
    if (!existsSync(configPath)) return null;
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    if (!config.browser?.enabled) return null;
    return {
      enabled: true,
      headless: config.browser.headless ?? true,
      timeout: config.browser.timeout ?? 30000,
      idleTimeout: config.browser.idleTimeout ?? 300000,
      defaultProfile: config.browser.defaultProfile ?? "default",
    };
  } catch (err: unknown) {
    console.warn("[kernel-options] Could not load browser config:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

const KERNEL_EFFORT_VALUES = ["low", "medium", "high", "max"] as const;
const SAFE_KERNEL_MODEL = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;
const KERNEL_CONFIG_MAX_BYTES = 256 * 1024;
export type KernelEffort = (typeof KERNEL_EFFORT_VALUES)[number];
export const DEFAULT_KERNEL_MODEL = "claude-opus-4-6";
export const DEFAULT_KERNEL_EFFORT: KernelEffort = "high";

function parseKernelConfigFile(raw: string): { model?: string; effort?: KernelEffort } {
  const config = JSON.parse(raw);
  const kernel = config.kernel;
  if (!kernel || typeof kernel !== "object") return {};
  const model = typeof kernel.model === "string" && SAFE_KERNEL_MODEL.test(kernel.model)
    ? kernel.model
    : undefined;
  const effort = KERNEL_EFFORT_VALUES.includes(kernel.effort) ? (kernel.effort as KernelEffort) : undefined;
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

function isMissingKernelConfig(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT";
}

function readKernelConfigBoundedSync(path: string): string | undefined {
  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > KERNEL_CONFIG_MAX_BYTES) return undefined;
    const buffer = Buffer.alloc(stat.size);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf-8");
  } finally {
    closeSync(fd);
  }
}

async function readKernelConfigBounded(path: string): Promise<string | undefined> {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > KERNEL_CONFIG_MAX_BYTES) return undefined;
    const buffer = Buffer.alloc(stat.size);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf-8");
  } finally {
    await file.close();
  }
}

// User-tunable kernel settings persisted by the gateway settings UI under the
// `kernel` key of ~/system/config.json (Everything Is a File). Read at spawn so
// changes take effect on the next kernel turn without a code change.
export function loadKernelConfigFile(homePath: string): { model?: string; effort?: KernelEffort } {
  try {
    const configPath = join(homePath, "system", "config.json");
    const raw = readKernelConfigBoundedSync(configPath);
    return raw === undefined ? {} : parseKernelConfigFile(raw);
  } catch (err: unknown) {
    if (!isMissingKernelConfig(err)) {
      console.warn("[kernel-options] Could not load kernel config:", err instanceof Error ? err.message : String(err));
    }
    return {};
  }
}

export async function loadKernelConfigFileAsync(
  homePath: string,
): Promise<{ model?: string; effort?: KernelEffort }> {
  try {
    const raw = await readKernelConfigBounded(join(homePath, "system", "config.json"));
    return raw === undefined ? {} : parseKernelConfigFile(raw);
  } catch (err: unknown) {
    if (!isMissingKernelConfig(err)) {
      console.warn("[kernel-options] Could not load kernel config:", err instanceof Error ? err.message : String(err));
    }
    return {};
  }
}

export function resolveKernelConfigFile(homePath: string): { model: string; effort: KernelEffort } {
  const fileKernel = loadKernelConfigFile(homePath);
  return {
    model: fileKernel.model ?? DEFAULT_KERNEL_MODEL,
    effort: fileKernel.effort ?? DEFAULT_KERNEL_EFFORT,
  };
}

export async function resolveKernelConfigFileAsync(
  homePath: string,
): Promise<{ model: string; effort: KernelEffort }> {
  const fileKernel = await loadKernelConfigFileAsync(homePath);
  return {
    model: fileKernel.model ?? DEFAULT_KERNEL_MODEL,
    effort: fileKernel.effort ?? DEFAULT_KERNEL_EFFORT,
  };
}

export async function tryCreateBrowserServer(
  homePath: string,
  browserConfig: { headless: boolean; timeout: number; idleTimeout: number; defaultProfile: string },
) {
  try {
    const { createBrowserMcpServer } = await import("@matrix-os/mcp-browser/server");
    return createBrowserMcpServer({ homePath, ...browserConfig });
  } catch (err: unknown) {
    console.warn("[kernel-options] Could not create browser MCP server:", err instanceof Error ? err.message : String(err));
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
  env?: Record<string, string | undefined>;
}

export async function kernelOptions(config: KernelConfig) {
  const { db, homePath, sessionId } = config;

  // Mirror canonical .agents/skills/ entries into .claude/skills/ so the SDK's
  // native Skill tool can discover them via settingSources: ['project'].
  // One source of truth (.agents/skills), two discovery paths (SDK + IPC).
  ensureSdkSkillsMirror(homePath);

  // Explicit per-call config wins; otherwise fall back to the persisted
  // ~/system/config.json kernel settings, then hardcoded defaults.
  const fileKernel = resolveKernelConfigFile(homePath);
  const effort = (config.effort ?? fileKernel.effort) as KernelEffort;
  const resolvedEffort = KERNEL_EFFORT_VALUES.includes(effort) ? effort : DEFAULT_KERNEL_EFFORT;

  const ipcServer = await createIpcServer(db, homePath);
  const coreAgents = getCoreAgents(homePath);
  const customAgents = loadCustomAgents(`${homePath}/agents/custom`, homePath);
  const agents = { ...coreAgents, ...customAgents };
  const systemPrompt = buildSystemPrompt(homePath, db);
  console.log("[kernel] System prompt length:", systemPrompt.length, "chars");
  console.log("[kernel] Contains app_data?", systemPrompt.includes("mcp__matrix-os-ipc__app_data"));
  const protectedFilesHook = createProtectedFilesHook(homePath);
  const gitSnapshotHook = createGitSnapshotHook(homePath);

  const mcpServers: Record<string, unknown> = { "matrix-os-ipc": ipcServer };
  const browserToolNames: string[] = [];

  const browserConfig = loadBrowserConfig(homePath);
  if (browserConfig) {
    const browserServer = await tryCreateBrowserServer(homePath, browserConfig);
    if (browserServer) {
      mcpServers["matrix-os-browser"] = browserServer;
      browserToolNames.push(...BROWSER_TOOL_NAMES);
    }
  }

  return {
    model: config.model ?? fileKernel.model,
    effort: resolvedEffort,
    systemPrompt,
    cwd: homePath,
    ...(config.env ? { env: config.env } : {}),
    settingSources: ["project"] as ("user" | "project" | "local")[],
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
      "Skill",
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
