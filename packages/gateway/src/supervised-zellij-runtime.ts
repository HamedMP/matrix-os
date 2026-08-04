import { resolve } from "node:path";
import {
  RuntimeIdSchema,
  createAgentConfigurationStore,
  type AgentConfiguration,
} from "@matrix-os/terminal-runtime";
import type { AgentLaunchSpec } from "./agent-launcher.js";
import type {
  GatewayTerminalRuntimeClient,
  GatewayTerminalRuntimeProjection,
} from "./shell/runtime-client.js";
import type { ZellijAdapter } from "./shell/zellij.js";
import type {
  ZellijHealth,
  ZellijStartResult,
} from "./zellij-runtime.js";

const MAX_RUNTIME_CACHE_ENTRIES = 2_048;
const AGENT_LAYOUT_PATH =
  "/opt/matrix/libexec/terminal-runtime/current/agent-layout.kdl";
const SHELL_LAYOUT_PATH =
  "/opt/matrix/libexec/terminal-runtime/current/layout.kdl";

type AgentConfigurationStore = {
  publish(
    configurationRef: string,
    configuration: AgentConfiguration,
  ): Promise<void>;
  remove(configurationRef: string): Promise<void>;
};

function zellijIdentity(runtimeId: string): string {
  return `matrix-t-${RuntimeIdSchema.parse(runtimeId)}`;
}

export function createSupervisedZellijRuntime(options: {
  homePath: string;
  runtime: GatewayTerminalRuntimeClient;
  zellij: ZellijAdapter;
  configurations?: AgentConfigurationStore;
}) {
  const homePath = resolve(options.homePath);
  const configurations =
    options.configurations ?? createAgentConfigurationStore();
  const bySessionId = new Map<string, GatewayTerminalRuntimeProjection>();

  function remember(
    sessionId: string,
    projection: GatewayTerminalRuntimeProjection,
  ): void {
    bySessionId.delete(sessionId);
    while (bySessionId.size >= MAX_RUNTIME_CACHE_ENTRIES) {
      const oldest = bySessionId.keys().next().value as string | undefined;
      if (!oldest) break;
      bySessionId.delete(oldest);
    }
    bySessionId.set(sessionId, projection);
  }

  async function projectionFor(
    sessionId: string,
  ): Promise<GatewayTerminalRuntimeProjection> {
    const cached = bySessionId.get(sessionId);
    if (cached) return cached;
    const projection = (await options.runtime.list())
      .find((candidate) => candidate.displayName === sessionId);
    if (!projection) throw new Error("terminal_runtime_not_resolved");
    remember(sessionId, projection);
    return projection;
  }

  function cachedIdentity(sessionId: string): string {
    const projection = bySessionId.get(sessionId);
    if (!projection) throw new Error("terminal_runtime_not_resolved");
    return zellijIdentity(projection.runtimeId);
  }

  return {
    async start(input: {
      sessionId: string;
      launch: AgentLaunchSpec;
    }): Promise<ZellijStartResult> {
      let projection: GatewayTerminalRuntimeProjection;
      if (input.launch.supervised) {
        const { configurationRef, configuration } = input.launch.supervised;
        await configurations.publish(configurationRef, configuration);
        try {
          projection = await options.runtime.createAgent({
            displayName: input.sessionId,
            cwd: input.launch.cwd,
            configurationRef,
          });
        } catch (error: unknown) {
          await configurations.remove(configurationRef).catch(
            (cleanupError: unknown) => {
              console.warn(
                "[terminal-runtime] agent configuration cleanup failed:",
                cleanupError instanceof Error
                  ? cleanupError.message
                  : String(cleanupError),
              );
            },
          );
          throw error;
        }
      } else {
        projection = await options.runtime.createShell({
          displayName: input.sessionId,
          cwd: input.launch.cwd,
        });
      }
      remember(input.sessionId, projection);
      return {
        ok: true,
        status: projection.lifecycleState === "live" ? "running" : "starting",
        sessionName: zellijIdentity(projection.runtimeId),
        runtimeId: projection.runtimeId,
        layoutPath: input.launch.supervised
          ? AGENT_LAYOUT_PATH
          : SHELL_LAYOUT_PATH,
      };
    },
    attachCommand(sessionId: string): string[] {
      return ["zellij", "attach", cachedIdentity(sessionId)];
    },
    observeCommand(sessionId: string): string[] {
      return [
        "zellij",
        "attach",
        cachedIdentity(sessionId),
        "--index",
        "0",
      ];
    },
    async sendInput(
      sessionId: string,
      input: string,
      _signal?: AbortSignal,
    ): Promise<void> {
      const projection = await projectionFor(sessionId);
      await options.zellij.sendInput(
        zellijIdentity(projection.runtimeId),
        input,
      );
    },
    async kill(sessionId: string): Promise<{ ok: true }> {
      const projection = await projectionFor(sessionId);
      await options.runtime.delete(projection.runtimeId);
      bySessionId.delete(sessionId);
      return { ok: true };
    },
    async health(): Promise<ZellijHealth> {
      try {
        await options.runtime.list();
        return {
          available: true,
          status: "ok",
          fallbackReason: null,
          version: null,
        };
      } catch (error: unknown) {
        console.warn(
          "[terminal-runtime] workspace runtime health failed:",
          error instanceof Error ? error.message : String(error),
        );
        return {
          available: false,
          status: "degraded",
          fallbackReason: "supervisor_unavailable",
          version: null,
        };
      }
    },
    homePath,
  };
}
