import { chmod, mkdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod/v4";
import { writeUtf8FileAtomic } from "./atomic-write.js";
import {
  AgentKindSchema,
  NormalizedAgentEventSchema,
  sanitizeAgentAction,
  sanitizeAgentSubtitle,
  type AgentKind,
  type NormalizedAgentEvent,
} from "./agent-session-state.js";

const AgentBridgeInputSchema = z.object({
  agent: AgentKindSchema,
  eventName: z.string().min(1).max(128),
  sessionName: z.string().min(1).max(64),
  occurredAt: z.iso.datetime({ offset: true }),
  payload: z.record(z.string(), z.unknown()),
}).strict();

export type AgentBridgeInput = z.infer<typeof AgentBridgeInputSchema>;

type JsonObject = Record<string, unknown>;

export function normalizeAgentBridgeEvents(rawInput: AgentBridgeInput): NormalizedAgentEvent[] {
  const input = AgentBridgeInputSchema.parse(rawInput);
  const payload = input.agent === "opencode"
    ? objectValue(input.payload.properties) ?? input.payload
    : input.payload;
  const type = normalizedType(input.agent, input.eventName, payload);
  if (!type) return [];

  const subtitle = supportsSubtitle(type)
    ? extractSubtitle(payload)
    : undefined;
  const action = actionForEvent(input.eventName, payload, type);
  return [NormalizedAgentEventSchema.parse({
    sessionName: input.sessionName,
    agent: input.agent,
    type,
    occurredAt: input.occurredAt,
    ...(subtitle ? { subtitle } : {}),
    ...(action ? { action } : {}),
  })];
}

function normalizedType(
  agent: AgentKind,
  eventName: string,
  payload: JsonObject,
): NormalizedAgentEvent["type"] | null {
  if (agent === "claude" || agent === "codex") {
    if (eventName === "UserPromptSubmit") return "turn-started";
    if (eventName === "PermissionRequest" || eventName === "Elicitation") return "attention-requested";
    if (eventName === "Notification" && isAttentionNotification(payload)) return "attention-requested";
    if (eventName === "Stop") return "turn-completed";
    if (eventName === "SessionEnd") return "session-ended";
    if (eventName === "PostToolUse" || eventName === "PostToolUseFailure") return "action-updated";
    return null;
  }
  if (agent === "opencode") {
    if (eventName === "permission.asked") return "attention-requested";
    if (eventName === "permission.replied") return "turn-started";
    if (eventName === "session.deleted") return "session-ended";
    if (eventName === "session.idle") return "turn-completed";
    if (eventName === "tool.execute.after") return "action-updated";
    if (eventName === "session.status") {
      const status = objectValue(payload.status);
      const value = stringValue(status?.type) ?? stringValue(payload.status);
      if (value === "busy" || value === "running") return "turn-started";
      if (value === "idle") return "turn-completed";
    }
    return null;
  }
  if (eventName === "before_agent_start" || eventName === "agent_start") return "turn-started";
  if (eventName === "agent_end") return "turn-completed";
  if (eventName === "tool_execution_end") return "action-updated";
  if (eventName === "session_shutdown") return "session-ended";
  return null;
}

function supportsSubtitle(type: NormalizedAgentEvent["type"]): boolean {
  return type === "turn-started" || type === "turn-completed" || type === "subtitle-updated";
}

function extractSubtitle(payload: JsonObject): string | undefined {
  const candidates = [
    payload.title,
    payload.summary,
    payload.last_assistant_message,
    payload.assistant_message,
    payload.prompt,
  ];
  for (const candidate of candidates) {
    const value = stringValue(candidate);
    if (!value) continue;
    const sentence = firstSentence(value);
    const sanitized = sanitizeAgentSubtitle(sentence);
    if (sanitized) return sanitized;
  }
  return undefined;
}

function firstSentence(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  const sentence = compact.match(/^.*?[.!?](?=\s|$)/)?.[0];
  return sentence ?? compact;
}

function actionForEvent(
  eventName: string,
  payload: JsonObject,
  type: NormalizedAgentEvent["type"],
): string | undefined {
  if (type === "attention-requested") return "Requested approval";
  if (type !== "action-updated") return undefined;

  const toolName = stringValue(payload.tool_name)
    ?? stringValue(payload.tool)
    ?? stringValue(objectValue(payload.tool)?.name)
    ?? stringValue(objectValue(payload.input)?.tool);
  const toolInput = objectValue(payload.tool_input)
    ?? objectValue(payload.args)
    ?? objectValue(payload.input)
    ?? {};
  const filePath = stringValue(toolInput.file_path)
    ?? stringValue(toolInput.filePath)
    ?? stringValue(toolInput.path);
  const normalizedTool = toolName?.toLowerCase();
  if (filePath && normalizedTool && ["edit", "write", "multiedit", "apply_patch"].includes(normalizedTool)) {
    return sanitizeAgentAction(`Edited ${basename(filePath)}`);
  }
  if (normalizedTool === "bash" || normalizedTool === "shell") return "Ran a terminal command";
  if (normalizedTool?.includes("task") || normalizedTool?.includes("agent")) return "Started a subagent";
  if (toolName) return sanitizeAgentAction(`Used ${toolName}`);
  return eventName === "tool_execution_end" ? "Completed a tool action" : undefined;
}

function isAttentionNotification(payload: JsonObject): boolean {
  const kind = stringValue(payload.notification_type) ?? stringValue(payload.type);
  return kind === "permission_prompt" || kind === "elicitation_dialog" || kind === "agent_needs_input";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function objectValue(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

const HookConfigSchema = z.object({
  hooks: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))).optional(),
}).passthrough();

export interface RegisterAgentBridgesOptions {
  homePath: string;
  command?: string;
}

export interface AgentBridgeRegistrationReport {
  registered: AgentKind[];
  failed: AgentKind[];
}

export async function registerAgentBridges(
  options: RegisterAgentBridgesOptions,
): Promise<AgentBridgeRegistrationReport> {
  const command = options.command ?? "/opt/matrix/bin/matrix-agent-bridge";
  const registrations: Array<{ agent: AgentKind; register: () => Promise<void> }> = [
    {
      agent: "claude",
      register: () => registerJsonHooks(join(options.homePath, ".claude", "settings.json"), "claude", command, [
        "UserPromptSubmit",
        "PermissionRequest",
        "Elicitation",
        "Notification",
        "PostToolUse",
        "PostToolUseFailure",
        "Stop",
        "SessionEnd",
      ], true),
    },
    {
      agent: "codex",
      register: () => registerJsonHooks(join(options.homePath, ".codex", "hooks.json"), "codex", command, [
        "UserPromptSubmit",
        "PermissionRequest",
        "PostToolUse",
        "Stop",
      ], false),
    },
    {
      agent: "opencode",
      register: () => writeOwnedBridgeFile(
        join(options.homePath, ".config", "opencode", "plugins", "matrix-session-metadata.js"),
        openCodePluginSource(command),
      ),
    },
    {
      agent: "pi",
      register: () => writeOwnedBridgeFile(
        join(options.homePath, ".pi", "agent", "extensions", "matrix-session-metadata.ts"),
        piExtensionSource(command),
      ),
    },
  ];
  const results = await Promise.all(registrations.map(async ({ agent, register }) => {
    try {
      await register();
      return { agent, registered: true } as const;
    } catch (error: unknown) {
      void error;
      return { agent, registered: false } as const;
    }
  }));
  return {
    registered: results.filter((result) => result.registered).map((result) => result.agent),
    failed: results.filter((result) => !result.registered).map((result) => result.agent),
  };
}

async function registerJsonHooks(
  path: string,
  agent: "claude" | "codex",
  command: string,
  events: string[],
  asynchronous: boolean,
): Promise<void> {
  const current = await readJsonIfPresent(path);
  const config = HookConfigSchema.parse(current ?? {});
  const hooks = { ...(config.hooks ?? {}) };
  for (const eventName of events) {
    const entries = [...(hooks[eventName] ?? [])];
    const hookCommand = `${command} ${agent} ${eventName}`;
    if (!entries.some((entry) => JSON.stringify(entry).includes(hookCommand))) {
      entries.push({
        ...(eventName.includes("Tool") ? { matcher: "*" } : {}),
        hooks: [{
          type: "command",
          command: hookCommand,
          ...(asynchronous ? { async: true } : {}),
          timeout: 5,
        }],
      });
    }
    hooks[eventName] = entries;
  }
  await writeOwnedBridgeFile(path, `${JSON.stringify({ ...config, hooks }, null, 2)}\n`);
}

async function readJsonIfPresent(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function writeOwnedBridgeFile(path: string, content: string): Promise<void> {
  const directory = join(path, "..");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeUtf8FileAtomic(path, content, 0o600);
  await chmod(path, 0o600);
}

function bridgeEmitterSource(agent: AgentKind, command: string): string {
  return `import { spawn } from "node:child_process";\n\nconst command = ${JSON.stringify(command)};\nfunction emit(eventName, payload) {\n  if (!process.env.ZELLIJ_SESSION_NAME) return;\n  try {\n    const child = spawn(command, [${JSON.stringify(agent)}, eventName], {\n      env: process.env,\n      stdio: ["pipe", "ignore", "ignore"],\n      detached: true,\n    });\n    child.on("error", () => undefined);\n    child.stdin.on("error", () => undefined);\n    const encoded = JSON.stringify(payload);\n    child.stdin.end(Buffer.byteLength(encoded, "utf8") <= 65536 ? encoded : "{}");\n    child.unref();\n  } catch (error) {\n    void error;\n    return;\n  }\n}\n`;
}

function openCodePluginSource(command: string): string {
  return `${bridgeEmitterSource("opencode", command)}\nexport const MatrixSessionMetadata = async () => ({\n  event: async ({ event }) => emit(event.type, event),\n  "tool.execute.after": async (input) => emit("tool.execute.after", input),\n});\n`;
}

function piExtensionSource(command: string): string {
  return `${bridgeEmitterSource("pi", command)}\nexport default function matrixSessionMetadata(pi) {\n  for (const eventName of ["before_agent_start", "agent_start", "agent_end", "tool_execution_end", "session_shutdown"]) {\n    pi.on(eventName, (event) => emit(eventName, event));\n  }\n}\n`;
}
