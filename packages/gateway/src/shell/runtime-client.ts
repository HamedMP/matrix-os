import { realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import {
  DisplayNameSchema,
  HomeRelativeCwdSchema,
  LifecycleStateSchema,
  MetadataRevisionSchema,
  OperationIdSchema,
  RecoveryReasonSchema,
  RuntimeIdSchema,
  createOperationId,
  createSupervisorClient,
  type HomeRelativeCwd,
  type ProtocolRequest,
  type SupervisorClient,
} from "@matrix-os/terminal-runtime";
import { z } from "zod/v4";
import type {
  AttachOptions,
  CreateSessionOptions,
  ZellijAdapter,
} from "./zellij.js";

const MAX_RUNTIME_PROJECTIONS = 2_048;
const RecoveryModeSchema = z.enum(["serialized", "fresh-shell"]).nullable();
const RuntimeProjectionSchema = z.object({
  runtimeId: RuntimeIdSchema,
  displayName: DisplayNameSchema.optional(),
  lifecycleState: LifecycleStateSchema,
  recoverable: z.boolean().default(false),
  recoveryReason: RecoveryReasonSchema.nullable().default(null),
  recoveryMode: RecoveryModeSchema.default(null),
  metadataRevision: MetadataRevisionSchema.optional(),
}).strict();
const RuntimeProjectionListSchema = z.array(RuntimeProjectionSchema)
  .max(MAX_RUNTIME_PROJECTIONS);
const StartProjectionSchema = z.object({
  runtimeId: RuntimeIdSchema,
  lifecycleState: LifecycleStateSchema,
}).passthrough();
const RenameProjectionSchema = z.object({
  runtimeId: RuntimeIdSchema,
  displayName: DisplayNameSchema,
  metadataRevision: MetadataRevisionSchema,
}).strict();

export type GatewayTerminalRuntimeProjection = z.infer<typeof RuntimeProjectionSchema>;
export type GatewayTerminalRuntimeMode = "legacy" | "supervised";

export function resolveGatewayTerminalRuntimeMode(
  value: string | undefined,
): GatewayTerminalRuntimeMode {
  if (value === undefined || value === "" || value === "legacy") return "legacy";
  if (value === "supervised") return "supervised";
  throw new Error("terminal_runtime_mode_invalid");
}

export function supervisedZellijEnvironment(
  homePath: string,
  uid = process.getuid?.() ?? 1000,
): Record<string, string> {
  const root = resolve(homePath, "system", "terminal-runtime");
  return {
    XDG_CACHE_HOME: resolve(root, "zellij-cache"),
    XDG_CONFIG_HOME: resolve(root, "zellij-config-home"),
    XDG_DATA_HOME: resolve(root, "zellij-data"),
    XDG_RUNTIME_DIR: `/run/user/${uid}`,
    ZELLIJ_CONFIG_DIR: "/opt/matrix/libexec/terminal-runtime/current",
    ZELLIJ_CONFIG_FILE:
      "/opt/matrix/libexec/terminal-runtime/current/config.kdl",
  };
}

export interface GatewayTerminalRuntimeClient {
  list(): Promise<GatewayTerminalRuntimeProjection[]>;
  inspect(runtimeId: string): Promise<GatewayTerminalRuntimeProjection>;
  createShell(input: {
    displayName: string;
    cwd?: string;
  }): Promise<GatewayTerminalRuntimeProjection>;
  createAgent(input: {
    displayName: string;
    cwd: string;
    configurationRef: string;
  }): Promise<GatewayTerminalRuntimeProjection>;
  rename(input: {
    runtimeId: string;
    displayName: string;
    baseRevision: number;
  }): Promise<GatewayTerminalRuntimeProjection>;
  delete(runtimeId: string): Promise<void>;
}

function terminalRuntimeError(code: string): Error {
  const error = new Error("terminal_runtime_request_failed");
  Object.defineProperty(error, "code", { value: code, enumerable: true });
  return error;
}

async function responseResult(
  supervisor: SupervisorClient,
  request: ProtocolRequest,
): Promise<unknown> {
  const response = await supervisor.request(request);
  if (!response.ok) throw terminalRuntimeError(response.error.code);
  return response.result;
}

async function homeRelativeCwd(homePath: string, cwd?: string): Promise<HomeRelativeCwd> {
  try {
    const root = await realpath(resolve(homePath));
    const target = await realpath(resolve(cwd ?? root));
    if (target !== root && !target.startsWith(`${root}${sep}`)) {
      throw new Error("terminal_cwd_invalid");
    }
    const path = relative(root, target).split(sep).join("/");
    return HomeRelativeCwdSchema.parse({ kind: "home-relative", path });
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "terminal_cwd_invalid") {
      throw error;
    }
    throw new Error("terminal_cwd_invalid", { cause: error });
  }
}

function completeStartProjection(
  result: unknown,
  displayName: string,
): GatewayTerminalRuntimeProjection {
  const parsed = StartProjectionSchema.parse(result);
  return RuntimeProjectionSchema.parse({
    ...parsed,
    displayName,
    metadataRevision: 1,
  });
}

export function createGatewayTerminalRuntimeClient(options: {
  homePath: string;
  supervisor?: SupervisorClient;
}): GatewayTerminalRuntimeClient {
  const supervisor = options.supervisor ?? createSupervisorClient();
  const homePath = resolve(options.homePath);
  return {
    async list() {
      const result = await responseResult(supervisor, {
        version: 1,
        operationId: createOperationId(),
        operation: "List",
        input: {},
      });
      return RuntimeProjectionListSchema.parse(result);
    },
    async inspect(runtimeId) {
      const trustedId = RuntimeIdSchema.parse(runtimeId);
      const result = await responseResult(supervisor, {
        version: 1,
        operationId: createOperationId(),
        operation: "Inspect",
        input: { runtimeId: trustedId },
      });
      return RuntimeProjectionSchema.parse(result);
    },
    async createShell(input) {
      const displayName = DisplayNameSchema.parse(input.displayName);
      const result = await responseResult(supervisor, {
        version: 1,
        operationId: createOperationId(),
        operation: "CreateStart",
        input: {
          displayName,
          cwd: await homeRelativeCwd(homePath, input.cwd),
          launch: { kind: "shell" },
        },
      });
      return completeStartProjection(result, displayName);
    },
    async createAgent(input) {
      const displayName = DisplayNameSchema.parse(input.displayName);
      const configurationRef = OperationIdSchema.parse(input.configurationRef);
      const result = await responseResult(supervisor, {
        version: 1,
        operationId: configurationRef,
        operation: "CreateStart",
        input: {
          displayName,
          cwd: await homeRelativeCwd(homePath, input.cwd),
          launch: { kind: "agent", configurationRef },
        },
      });
      return completeStartProjection(result, displayName);
    },
    async rename(input) {
      const runtimeId = RuntimeIdSchema.parse(input.runtimeId);
      const displayName = DisplayNameSchema.parse(input.displayName);
      const baseRevision = MetadataRevisionSchema.parse(input.baseRevision);
      const result = await responseResult(supervisor, {
        version: 1,
        operationId: createOperationId(),
        operation: "RenameMetadata",
        input: { runtimeId, displayName, baseRevision },
      });
      const renamed = RenameProjectionSchema.parse(result);
      return RuntimeProjectionSchema.parse({
        ...renamed,
        lifecycleState: "live",
      });
    },
    async delete(runtimeId) {
      const trustedId = RuntimeIdSchema.parse(runtimeId);
      await responseResult(supervisor, {
        version: 1,
        operationId: createOperationId(),
        operation: "Delete",
        input: { runtimeId: trustedId },
      });
    },
  };
}

export async function initializeGatewayTerminalRuntime(options: {
  mode: GatewayTerminalRuntimeMode;
  nodeEnv?: string;
  homePath: string;
  supervisor?: SupervisorClient;
}): Promise<GatewayTerminalRuntimeClient | null> {
  if (options.mode === "legacy") return null;
  const runtime = createGatewayTerminalRuntimeClient(options);
  try {
    await runtime.list();
  } catch (error: unknown) {
    if (options.nodeEnv !== "production") throw error;
    throw new Error("terminal_supervisor_unavailable", { cause: error });
  }
  return runtime;
}

function zellijIdentity(runtimeId: string): string {
  return `matrix-t-${RuntimeIdSchema.parse(runtimeId)}`;
}

export function createSupervisedZellijAdapter(options: {
  runtime: GatewayTerminalRuntimeClient;
  zellij: ZellijAdapter;
}): ZellijAdapter {
  const byName = new Map<string, GatewayTerminalRuntimeProjection>();

  function remember(projection: GatewayTerminalRuntimeProjection): void {
    if (!projection.displayName) return;
    byName.delete(projection.displayName);
    while (byName.size >= MAX_RUNTIME_PROJECTIONS) {
      const oldest = byName.keys().next().value as string | undefined;
      if (!oldest) break;
      byName.delete(oldest);
    }
    byName.set(projection.displayName, projection);
  }

  function resolved(name: string): GatewayTerminalRuntimeProjection {
    const projection = byName.get(DisplayNameSchema.parse(name));
    if (!projection) throw new Error("terminal_runtime_not_resolved");
    return projection;
  }

  async function resolveName(name: string): Promise<GatewayTerminalRuntimeProjection> {
    const trustedName = DisplayNameSchema.parse(name);
    const cached = byName.get(trustedName);
    if (cached) return cached;
    const projection = (await options.runtime.list())
      .find((candidate) => candidate.displayName === trustedName);
    if (!projection) throw new Error("terminal_runtime_not_resolved");
    remember(projection);
    return projection;
  }

  async function mappedName(name: string): Promise<string> {
    return zellijIdentity((await resolveName(name)).runtimeId);
  }

  return {
    runtimeProjection(name: string) {
      return byName.get(DisplayNameSchema.parse(name)) ?? null;
    },
    async health() {
      try {
        await options.runtime.list();
        return await options.zellij.health();
      } catch (error: unknown) {
        console.warn(
          "[terminal-runtime] supervised health unavailable:",
          error instanceof Error ? error.message : String(error),
        );
        return { ok: false, code: "zellij_failed" };
      }
    },
    async listSessions() {
      const projections = await options.runtime.list();
      byName.clear();
      const live: string[] = [];
      for (const projection of projections) {
        remember(projection);
        if (
          projection.displayName &&
          ["starting", "live", "recovering"].includes(projection.lifecycleState)
        ) {
          live.push(projection.displayName);
        }
      }
      return live;
    },
    async focusedPaneCwd(name) {
      return await options.zellij.focusedPaneCwd(await mappedName(name));
    },
    async createSession(input: CreateSessionOptions) {
      if (input.layout || input.cmd) {
        throw new Error("terminal_supervised_launch_unsupported");
      }
      remember(await options.runtime.createShell({
        displayName: input.name,
        ...(input.cwd ? { cwd: input.cwd } : {}),
      }));
    },
    async deleteSession(name) {
      const projection = await resolveName(name);
      await options.runtime.delete(projection.runtimeId);
      if (projection.displayName) byName.delete(projection.displayName);
    },
    async renameSession(name, nextName) {
      const projection = await resolveName(name);
      if (!projection.metadataRevision) {
        throw new Error("terminal_metadata_unavailable");
      }
      const renamed = await options.runtime.rename({
        runtimeId: projection.runtimeId,
        displayName: nextName,
        baseRevision: projection.metadataRevision,
      });
      if (projection.displayName) byName.delete(projection.displayName);
      remember(renamed);
    },
    async validateLayout(path) {
      await options.zellij.validateLayout(path);
    },
    attachSession(name: string, attachOptions: AttachOptions = {}) {
      return options.zellij.attachSession(
        zellijIdentity(resolved(name).runtimeId),
        attachOptions,
      );
    },
    async sendInput(name, data) {
      await options.zellij.sendInput(await mappedName(name), data);
    },
    async listTabs(name) {
      return await options.zellij.listTabs(await mappedName(name));
    },
    async createTab(name, input) {
      return await options.zellij.createTab(await mappedName(name), input);
    },
    async switchTab(name, tab) {
      return await options.zellij.switchTab(await mappedName(name), tab);
    },
    async closeTab(name, tab) {
      return await options.zellij.closeTab(await mappedName(name), tab);
    },
    async splitPane(name, input) {
      return await options.zellij.splitPane(await mappedName(name), input);
    },
    async closePane(name, pane) {
      return await options.zellij.closePane(await mappedName(name), pane);
    },
    async applyLayout(name, layout) {
      return await options.zellij.applyLayout(await mappedName(name), layout);
    },
    async dumpLayout(name) {
      return await options.zellij.dumpLayout(await mappedName(name));
    },
    async setShellTheme(themeId) {
      await options.zellij.setShellTheme(themeId);
    },
  };
}
