import {
  AgentMessagingSelectionSchema,
  AgentProviderCatalogSchema,
  AgentRuntimeDescriptorSchema,
  AgentRuntimeSelectionSchema,
  type AgentRuntimeId,
  type AgentRuntimeSelection,
} from "@matrix-os/contracts";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AgentConfigError } from "./errors.js";
import { createHermesRuntimeAdapter } from "./hermes-adapter.js";
import { createHermesRuntimeSource, type HermesJsonReader } from "./hermes-source.js";
import {
  createHostRuntimeControl,
  readOpenClawGatewayToken,
  type HostRuntimeControl,
  type HostRuntimeStatus,
} from "./host-runtime-control.js";
import { createOpenClawRuntimeAdapter } from "./openclaw-adapter.js";
import {
  createOpenClawRpcClient,
  type OpenClawRpcClient,
} from "./openclaw-rpc.js";
import {
  createAgentRuntimeController,
  type AgentRuntimeController,
} from "./runtime-controller.js";
import { readAgentConfig, readConfig } from "./runtime-files.js";
import type { MessagingRuntimeAdapter } from "./runtime-types.js";
import type {
  AgentRuntimeSettingsSnapshot,
  AgentRuntimeSource,
} from "./service.js";

interface HermesRuntimeClient {
  readJson: HermesJsonReader;
  requestJson(
    path: string,
    init: Omit<RequestInit, "signal" | "redirect">,
    signal: AbortSignal,
  ): Promise<unknown>;
}

export interface HermesAgentRuntimeServices {
  source: AgentRuntimeSource;
  controller: AgentRuntimeController;
}

export interface AgentRuntimeServices extends HermesAgentRuntimeServices {}

interface LazyOpenClawRpcOptions {
  readToken?: (homePath: string) => Promise<string>;
  createClient?: typeof createOpenClawRpcClient;
}

interface ResettableOpenClawRpc extends OpenClawRpcClient {
  reset(): Promise<void>;
}

export function createLazyOpenClawRpc(
  homePath: string,
  options: LazyOpenClawRpcOptions = {},
): ResettableOpenClawRpc {
  let client: OpenClawRpcClient | null = null;
  let pending: Promise<OpenClawRpcClient> | null = null;
  let resetting: Promise<void> | null = null;
  let closed = false;
  let epoch = 0;
  const readToken = options.readToken ?? readOpenClawGatewayToken;
  const createClient = options.createClient ?? createOpenClawRpcClient;

  async function getClient(): Promise<OpenClawRpcClient> {
    if (closed) throw new AgentConfigError("runtime_unavailable");
    await resetting;
    if (closed) throw new AgentConfigError("runtime_unavailable");
    if (client !== null) return client;
    if (pending === null) {
      const creationEpoch = epoch;
      const creation = readToken(homePath).then((token) => {
        const created = createClient({
          url: "ws://127.0.0.1:18789",
          token,
        });
        if (!closed && epoch === creationEpoch) client = created;
        return created;
      }).finally(() => {
        if (pending === creation) pending = null;
      });
      pending = creation;
    }
    const requestEpoch = epoch;
    const active = await pending;
    // close() marks the wrapper closed before awaiting an in-flight creation.
    // Recheck after that shared promise settles so no caller can start an RPC
    // on the client that the shutdown path is about to close.
    if (closed) throw new AgentConfigError("runtime_unavailable");
    if (epoch !== requestEpoch) return getClient();
    return active;
  }

  async function reset(): Promise<void> {
    if (closed) throw new AgentConfigError("runtime_unavailable");
    if (resetting !== null) return resetting;
    epoch += 1;
    const active = client;
    const creating = pending;
    client = null;
    const operation = (async () => {
      const created = active ?? await creating?.catch((error: unknown) => {
        console.warn(
          "[agent-config] OpenClaw RPC creation stopped during reset:",
          error instanceof Error ? error.name : "UnknownError",
        );
        return null;
      }) ?? null;
      await created?.close();
    })();
    resetting = operation;
    try {
      await operation;
    } finally {
      if (resetting === operation) resetting = null;
    }
  }

  return {
    async call(method, params, signal) {
      return (await getClient()).call(method, params, signal);
    },
    reset,
    async close() {
      const resetInFlight = resetting;
      const activeClient = client;
      const creatingClient = pending;
      closed = true;
      epoch += 1;
      await resetInFlight;
      const active = resetInFlight === null
        ? activeClient ?? await creatingClient?.catch((error: unknown) => {
          console.warn(
            "[agent-config] OpenClaw RPC creation stopped during shutdown:",
            error instanceof Error ? error.name : "UnknownError",
          );
          return null;
        }) ?? null
        : null;
      await active?.close();
      client = null;
    },
  };
}

async function resetOpenClawRpc(rpc: OpenClawRpcClient): Promise<void> {
  const reset = (rpc as Partial<ResettableOpenClawRpc>).reset;
  if (typeof reset === "function") await reset.call(rpc);
}

export async function waitForOpenClawReady(
  rpc: OpenClawRpcClient,
  signal: AbortSignal,
  timeoutMs = 10_000,
): Promise<void> {
  const readinessSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(timeoutMs),
  ]);
  while (true) {
    try {
      await rpc.call("health", {}, readinessSignal);
      return;
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      if (readinessSignal.aborted) {
        throw new AgentConfigError("runtime_switch_failed", error);
      }
      try {
        await delay(250, undefined, { signal: readinessSignal });
      } catch (delayError) {
        if (signal.aborted) throw signal.reason ?? delayError;
        throw new AgentConfigError("runtime_switch_failed", delayError);
      }
    }
  }
}

function capabilities(runtime: AgentRuntimeId) {
  return runtime === "hermes"
    ? [
        "provider_catalog" as const,
        "model_selection" as const,
        "authentication" as const,
        "messaging_dashboard" as const,
      ]
    : [
        "provider_catalog" as const,
        "model_selection" as const,
        "authentication" as const,
      ];
}

function baseDescriptor(
  runtime: AgentRuntimeId,
  selected: AgentRuntimeId,
  status: HostRuntimeStatus[AgentRuntimeId] | undefined,
) {
  const isSelected = runtime === selected;
  const installed = status?.installed;
  return AgentRuntimeDescriptorSchema.parse({
    id: runtime,
    displayName: runtime === "hermes" ? "Hermes" : "OpenClaw",
    installState: installed === undefined ? "unknown" : installed ? "installed" : "missing",
    health: status?.running ? "degraded" : status === undefined ? "unknown" : "stopped",
    selectionState: isSelected
      ? "active"
      : installed === true
        ? "available"
        : installed === false
          ? "unavailable"
          : "action_required",
    configured: false,
    capabilities: installed === false ? ["install"] : capabilities(runtime),
    ...(installed === false ? { setupAction: "install" as const } : {}),
  });
}

function createUnifiedRuntimeSource(options: {
  homePath: string;
  adapters: Record<AgentRuntimeId, MessagingRuntimeAdapter>;
  hostControl: HostRuntimeControl;
}): AgentRuntimeSource {
  const configPath = join(options.homePath, "system/config.json");
  return async (signal): Promise<AgentRuntimeSettingsSnapshot> => {
    signal.throwIfAborted();
    const config = await readConfig(configPath);
    const selected = readAgentConfig(config).value.messagingRuntime ?? "hermes";
    let hostStatus: HostRuntimeStatus | undefined;
    try {
      hostStatus = await options.hostControl.status(signal);
    } catch (error) {
      if (signal.aborted) throw error;
      console.warn(
        "[agent-config] Host runtime status failed:",
        error instanceof Error ? error.name : "UnknownError",
      );
    }

    const descriptors = new Map<AgentRuntimeId, ReturnType<typeof baseDescriptor>>([
      ["hermes", baseDescriptor("hermes", selected, hostStatus?.hermes)],
      ["openclaw", baseDescriptor("openclaw", selected, hostStatus?.openclaw)],
    ]);
    let providers: AgentRuntimeSettingsSnapshot["providers"] = [];
    let messaging = AgentMessagingSelectionSchema.parse({
      runtime: selected,
      provider: null,
      model: null,
      configured: false,
    });
    const adapter = options.adapters[selected];
    if (hostStatus?.[selected].running === true
      || (hostStatus === undefined && selected === "hermes")) {
      const [probeResult, catalogResult, selectionResult] = await Promise.allSettled([
        adapter.probe(signal),
        adapter.catalog(signal),
        adapter.selection(signal),
      ]);
      signal.throwIfAborted();
      if (probeResult.status === "fulfilled") {
        const probed = AgentRuntimeDescriptorSchema.parse(probeResult.value);
        descriptors.set(selected, AgentRuntimeDescriptorSchema.parse({
          ...probed,
          selectionState: "active",
        }));
      }
      if (catalogResult.status === "fulfilled") {
        providers = AgentProviderCatalogSchema.parse(catalogResult.value)
          .filter((provider) => provider.runtime === selected);
      }
      if (selectionResult.status === "fulfilled") {
        const selection = AgentMessagingSelectionSchema.parse(selectionResult.value);
        const selectedModelIsCataloged = !selection.configured || providers.some((provider) =>
          provider.runtime === selected
          && provider.id === selection.provider
          && provider.models.some((model) =>
            model.id === selection.model && model.available
          )
        );
        if (selectedModelIsCataloged) messaging = selection;
      }
      if ([probeResult, catalogResult, selectionResult]
        .some((result) => result.status === "rejected")) {
        console.warn("[agent-config] Active runtime inventory is degraded");
      }
    }

    const runtime: AgentRuntimeSelection = AgentRuntimeSelectionSchema.parse({
      selected,
      options: [descriptors.get("hermes"), descriptors.get("openclaw")],
      transition: null,
    });
    return { runtime, providers, messaging };
  };
}

export function createHermesAgentRuntimeServices(options: {
  homePath: string;
  client: HermesRuntimeClient;
}): HermesAgentRuntimeServices {
  const source = createHermesRuntimeSource(options.client.readJson);
  const adapter = createHermesRuntimeAdapter({
    source,
    requestJson: options.client.requestJson,
  });
  const controller = createAgentRuntimeController({
    homePath: options.homePath,
    adapters: { hermes: adapter },
  });
  return { source, controller };
}

export function createAgentRuntimeServices(options: {
  homePath: string;
  client: HermesRuntimeClient;
  hostControl?: HostRuntimeControl;
  openClawRpc?: OpenClawRpcClient;
}): AgentRuntimeServices {
  const hostControl = options.hostControl ?? createHostRuntimeControl();
  const hermesSource = createHermesRuntimeSource(options.client.readJson);
  const openClawRpc = options.openClawRpc ?? createLazyOpenClawRpc(options.homePath);
  const hermes = createHermesRuntimeAdapter({
    source: hermesSource,
    requestJson: options.client.requestJson,
    async prepare(signal) {
      const status = await hostControl.status(signal);
      if (!status.hermes.installed) throw new AgentConfigError("runtime_unavailable");
    },
    async activate(signal) {
      hermesSource.invalidate?.();
      await hostControl.switch("hermes", signal);
      hermesSource.invalidate?.();
    },
    deactivate: async () => {},
  });
  const openclaw = createOpenClawRuntimeAdapter({
    rpc: openClawRpc,
    lifecycle: {
      async status(signal) {
        const status = await hostControl.status(signal);
        return {
          installed: status.openclaw.installed,
          active: status.openclaw.running,
        };
      },
      async activate(signal) {
        await resetOpenClawRpc(openClawRpc);
        await hostControl.switch("openclaw", signal);
        await waitForOpenClawReady(openClawRpc, signal);
      },
      async deactivate() {
        await resetOpenClawRpc(openClawRpc);
      },
    },
  });
  const adapters = { hermes, openclaw };
  const source = createUnifiedRuntimeSource({
    homePath: options.homePath,
    adapters,
    hostControl,
  });
  const controller = createAgentRuntimeController({
    homePath: options.homePath,
    adapters,
    timeoutMs: 75_000,
  });
  return { source, controller };
}
