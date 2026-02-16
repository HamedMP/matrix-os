import type { Context } from "hono";

export interface PluginManifest {
  id: string;
  name?: string;
  version?: string;
  description?: string;
  configSchema: Record<string, unknown>;
  channels?: string[];
  skills?: string[];
}

export type PluginOrigin = "bundled" | "workspace" | "config";

export interface DiscoveredPlugin {
  manifest: PluginManifest;
  path: string;
  origin: PluginOrigin;
}

export interface PluginLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
}

export interface ToolDefinition {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  execute: (params: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

export interface HttpRoute {
  path: string;
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  handler: (c: Context) => Response | Promise<Response>;
}

export interface BackgroundService {
  name: string;
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
}

export type VoidHookName =
  | "message_received"
  | "message_sent"
  | "agent_end"
  | "session_start"
  | "session_end"
  | "gateway_start"
  | "gateway_stop";

export type ModifyingHookName =
  | "before_agent_start"
  | "message_sending"
  | "before_tool_call"
  | "after_tool_call";

export type HookName = VoidHookName | ModifyingHookName;

export const VOID_HOOKS: Set<HookName> = new Set([
  "message_received",
  "message_sent",
  "agent_end",
  "session_start",
  "session_end",
  "gateway_start",
  "gateway_stop",
]);

export const MODIFYING_HOOKS: Set<HookName> = new Set([
  "before_agent_start",
  "message_sending",
  "before_tool_call",
  "after_tool_call",
]);

export interface HookOpts {
  priority?: number;
}

export interface BeforeAgentStartResult {
  systemPrompt?: string;
  prependContext?: string;
}

export interface MessageSendingResult {
  cancel?: boolean;
  content?: string;
}

export interface BeforeToolCallResult {
  block?: boolean;
  blockReason?: string;
  params?: Record<string, unknown>;
}

export interface AfterToolCallResult {
  result?: unknown;
}

export type ModifyingHookResult =
  | BeforeAgentStartResult
  | MessageSendingResult
  | BeforeToolCallResult
  | AfterToolCallResult;

export type HookHandler = (context: Record<string, unknown>) => void | Promise<void> | ModifyingHookResult | Promise<ModifyingHookResult | void>;

export interface RegisteredHook {
  pluginId: string;
  event: HookName;
  handler: HookHandler;
  priority: number;
}

export interface MatrixOSPluginApi {
  id: string;
  config: Record<string, unknown>;
  pluginConfig?: Record<string, unknown>;
  home: string;
  logger: PluginLogger;

  registerTool(tool: ToolDefinition): void;
  registerHook(event: HookName, handler: HookHandler, opts?: HookOpts): void;
  registerChannel(adapter: unknown): void;
  registerHttpRoute(route: HttpRoute): void;
  registerService(service: BackgroundService): void;
  registerSkill(skillPath: string): void;

  resolvePath(input: string): string;
}

export type PluginModule =
  | { register: (api: MatrixOSPluginApi) => void | Promise<void> }
  | ((api: MatrixOSPluginApi) => void | Promise<void>);

export interface LoadedPlugin {
  manifest: PluginManifest;
  path: string;
  origin: PluginOrigin;
  status: "loaded" | "error";
  error?: string;
  loadTimeMs?: number;
}
