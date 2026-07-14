import {
  AgentRuntimeDescriptorSchema,
  type AgentMessagingSelection,
  type AgentRuntimeId,
  type AgentSettingsUpdate,
} from "@matrix-os/contracts";
import { lstat, mkdir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { AgentConfigError, isAgentConfigError } from "./errors.js";
import {
  ConfigRecordSchema,
  TransitionStateSchema,
  acquireLock,
  isErrno,
  logBestEffortFailure,
  readAgentConfig,
  readConfig,
  validateStartupTransitionMarker,
  writeJsonAtomic,
  type TransitionState,
} from "./runtime-files.js";
import type { MessagingRuntimeAdapter } from "./runtime-types.js";
export type { MessagingRuntimeAdapter, RuntimeConfigureInput } from "./runtime-types.js";

interface AgentRuntimeControllerOptions {
  homePath: string;
  adapters: Partial<Record<AgentRuntimeId, MessagingRuntimeAdapter>>;
  pauseDelivery?: (signal: AbortSignal) => Promise<void>;
  drainDelivery?: (signal: AbortSignal) => Promise<void>;
  resumeDelivery?: (
    runtime: AgentRuntimeId,
    signal: AbortSignal,
  ) => Promise<void>;
  timeoutMs?: number;
  now?: () => Date;
}

export interface AgentRuntimeUpdateResult {
  revision: number;
  runtime: AgentRuntimeId;
  selection: AgentMessagingSelection;
}

export interface AgentKernelPatchResult {
  model: unknown;
  effort: unknown;
}

export interface AgentRuntimeController {
  update(update: AgentSettingsUpdate): Promise<AgentRuntimeUpdateResult>;
  updateKernel(
    patch: Pick<AgentSettingsUpdate, "model" | "effort">,
  ): Promise<AgentKernelPatchResult>;
  reconcile(): Promise<void>;
  close(): Promise<void>;
}

function deadlineSignal(timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    abort: () => controller.abort(),
    close: () => clearTimeout(timer),
  };
}

function mapSwitchError(error: unknown): AgentConfigError {
  if (isAgentConfigError(error)) return error;
  return new AgentConfigError("runtime_switch_failed", error);
}

export function createAgentRuntimeController(
  options: AgentRuntimeControllerOptions,
): AgentRuntimeController {
  const configPath = join(options.homePath, "system/config.json");
  const runtimeDir = join(options.homePath, "system/agent-runtime");
  const lockPath = join(runtimeDir, "transition.lock");
  const transitionPath = join(runtimeDir, "transition.json");
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw new RangeError("Invalid runtime transition timeout");
  }
  const now = options.now ?? (() => new Date());
  const pauseDelivery = options.pauseDelivery ?? (async () => {});
  const drainDelivery = options.drainDelivery ?? (async () => {});
  const resumeDelivery = options.resumeDelivery ?? (async () => {});
  let closed = false;
  let activeAbort: (() => void) | null = null;
  let activeOperation: Promise<unknown> | null = null;
  let closePromise: Promise<void> | null = null;

  async function performUpdate(
    updateInput: AgentSettingsUpdate,
  ): Promise<AgentRuntimeUpdateResult> {
    const releaseLock = await acquireLock(lockPath);
    const deadline = deadlineSignal(timeoutMs);
    activeAbort = deadline.abort;
    let hasTransition = false;
    try {
      const config = await readConfig(configPath);
      const agent = readAgentConfig(config);
      const revision = agent.value.revision ?? 0;
      if (updateInput.revision !== revision) {
        throw new AgentConfigError("agent_config_conflict");
      }
      const currentRuntime = agent.value.messagingRuntime ?? "hermes";
      const targetRuntime = updateInput.runtime ?? currentRuntime;
      const currentAdapter = options.adapters[currentRuntime];
      const targetAdapter = options.adapters[targetRuntime];
      if (!targetAdapter) {
        throw new AgentConfigError("runtime_unavailable");
      }

      const nextRevision = revision + 1;
      const hasKernelPatch = updateInput.model !== undefined
        || updateInput.effort !== undefined;
      let nextKernel: Record<string, unknown> | undefined;
      if (hasKernelPatch) {
        const parsedKernel = ConfigRecordSchema.safeParse(config.kernel ?? {});
        if (!parsedKernel.success) {
          throw new AgentConfigError("agent_config_invalid", parsedKernel.error);
        }
        nextKernel = {
          ...parsedKernel.data,
          ...(updateInput.model === undefined ? {} : { model: updateInput.model }),
          ...(updateInput.effort === undefined ? {} : { effort: updateInput.effort }),
        };
      }
      const nextConfig = {
        ...config,
        ...(nextKernel === undefined ? {} : { kernel: nextKernel }),
        agent: {
          ...agent.stored,
          messagingRuntime: targetRuntime,
          revision: nextRevision,
          updatedAt: now().toISOString(),
        },
      };

      if (targetRuntime === currentRuntime) {
        const previousSelection = await targetAdapter.selection(deadline.signal);
        let selection = previousSelection;
        if (updateInput.provider !== undefined
          && updateInput.messagingModel !== undefined) {
          selection = await targetAdapter.configure({
            provider: updateInput.provider,
            model: updateInput.messagingModel,
            ...(updateInput.baseUrl === undefined
              ? {}
              : { baseUrl: updateInput.baseUrl }),
          }, deadline.signal);
        }
        try {
          await writeJsonAtomic(configPath, nextConfig);
        } catch (error) {
          if (previousSelection.configured
            && previousSelection.provider !== null
            && previousSelection.model !== null
            && (previousSelection.provider !== selection.provider
              || previousSelection.model !== selection.model)) {
            const rollbackSignal = AbortSignal.timeout(2_000);
            await targetAdapter.configure({
              provider: previousSelection.provider,
              model: previousSelection.model,
            }, rollbackSignal).catch((error: unknown) => {
              logBestEffortFailure("Provider selection restore failed", error);
            });
          }
          throw error;
        }
        return { revision: nextRevision, runtime: targetRuntime, selection };
      }

      const startedAt = now();
      const baseTransition = {
        id: randomUUID(),
        from: currentRuntime,
        to: targetRuntime,
        startedAt: startedAt.toISOString(),
        deadlineAt: new Date(startedAt.getTime() + timeoutMs).toISOString(),
      };
      const setTransition = async (state: TransitionState["state"]) => {
        const transition = TransitionStateSchema.parse({
          ...baseTransition,
          state,
        });
        await writeJsonAtomic(transitionPath, transition);
        hasTransition = true;
      };

      let deliveryPaused = false;
      let currentDeactivated = false;
      let targetActivationAttempted = false;
      let committed = false;
      let previousTargetSelection: AgentMessagingSelection | null = null;
      let targetConfigured = false;
      try {
        await setTransition("validating");
        await targetAdapter.prepare(deadline.signal);
        await setTransition("pausing");
        await pauseDelivery(deadline.signal);
        deliveryPaused = true;
        await setTransition("draining");
        const drainSignal = AbortSignal.any([
          deadline.signal,
          AbortSignal.timeout(Math.min(5_000, timeoutMs)),
        ]);
        await drainDelivery(drainSignal);
        if (currentAdapter) {
          await currentAdapter.deactivate(deadline.signal);
          currentDeactivated = true;
        }
        await setTransition("activating");
        targetActivationAttempted = true;
        await targetAdapter.activate(deadline.signal);
        await setTransition("verifying");
        const descriptor = AgentRuntimeDescriptorSchema.parse(
          await targetAdapter.probe(deadline.signal),
        );
        if (descriptor.health !== "healthy") {
          throw new AgentConfigError("runtime_switch_failed");
        }
        previousTargetSelection = await targetAdapter.selection(deadline.signal);
        let selection = previousTargetSelection;
        if (updateInput.provider !== undefined
          && updateInput.messagingModel !== undefined) {
          selection = await targetAdapter.configure({
            provider: updateInput.provider,
            model: updateInput.messagingModel,
            ...(updateInput.baseUrl === undefined
              ? {}
              : { baseUrl: updateInput.baseUrl }),
          }, deadline.signal);
          targetConfigured = true;
        }
        await setTransition("committing");
        await writeJsonAtomic(configPath, nextConfig);
        committed = true;
        await resumeDelivery(targetRuntime, deadline.signal);
        deliveryPaused = false;
        return { revision: nextRevision, runtime: targetRuntime, selection };
      } catch (error) {
        const rollbackSignal = AbortSignal.timeout(2_000);
        if (targetConfigured
          && previousTargetSelection?.configured
          && previousTargetSelection.provider !== null
          && previousTargetSelection.model !== null) {
          await targetAdapter.configure({
            provider: previousTargetSelection.provider,
            model: previousTargetSelection.model,
          }, rollbackSignal).catch((rollbackError: unknown) => {
            logBestEffortFailure("Target provider restore failed", rollbackError);
          });
        }
        if (targetActivationAttempted || currentDeactivated) {
          await setTransition("rolling_back").catch((rollbackError: unknown) => {
            logBestEffortFailure("Rollback marker write failed", rollbackError);
          });
          if (targetActivationAttempted) {
            await targetAdapter.deactivate(rollbackSignal).catch((rollbackError: unknown) => {
              logBestEffortFailure("Target runtime rollback failed", rollbackError);
            });
          }
          if (currentDeactivated && currentAdapter) {
            await currentAdapter.activate(rollbackSignal).catch((rollbackError: unknown) => {
              logBestEffortFailure("Previous runtime restore failed", rollbackError);
            });
          }
        }
        if (committed) {
          await writeJsonAtomic(configPath, config).catch((rollbackError: unknown) => {
            logBestEffortFailure("Owner config rollback failed", rollbackError);
          });
        }
        if (deliveryPaused) {
          await resumeDelivery(currentRuntime, rollbackSignal).catch((rollbackError: unknown) => {
            logBestEffortFailure("Previous runtime delivery resume failed", rollbackError);
          });
        }
        throw mapSwitchError(error);
      }
    } finally {
      activeAbort = null;
      deadline.close();
      if (hasTransition) {
        await unlink(transitionPath).catch((error: unknown) => {
          if (!isErrno(error, "ENOENT")) {
            console.warn(
              "[agent-config] Failed to remove transition marker:",
              error instanceof Error ? error.name : "UnknownError",
            );
          }
        });
      }
      await releaseLock();
    }
  }

  function update(
    updateInput: AgentSettingsUpdate,
  ): Promise<AgentRuntimeUpdateResult> {
    if (closed) return Promise.reject(new AgentConfigError("runtime_unavailable"));
    if (activeOperation !== null) {
      return Promise.reject(new AgentConfigError("agent_config_conflict"));
    }
    const pending = performUpdate(updateInput);
    activeOperation = pending;
    const clearPending = () => {
      if (activeOperation === pending) activeOperation = null;
    };
    void pending.then(clearPending, clearPending);
    return pending;
  }

  async function performKernelUpdate(
    patch: Pick<AgentSettingsUpdate, "model" | "effort">,
  ): Promise<AgentKernelPatchResult> {
    if (patch.model === undefined && patch.effort === undefined) {
      throw new AgentConfigError("agent_config_invalid");
    }
    const releaseLock = await acquireLock(lockPath);
    try {
      const config = await readConfig(configPath);
      const parsedKernel = ConfigRecordSchema.safeParse(config.kernel ?? {});
      if (!parsedKernel.success) {
        throw new AgentConfigError("agent_config_invalid", parsedKernel.error);
      }
      const kernel = {
        ...parsedKernel.data,
        ...(patch.model === undefined ? {} : { model: patch.model }),
        ...(patch.effort === undefined ? {} : { effort: patch.effort }),
      };
      await writeJsonAtomic(configPath, { ...config, kernel });
      return { model: kernel.model, effort: kernel.effort };
    } finally {
      await releaseLock();
    }
  }

  function updateKernel(
    patch: Pick<AgentSettingsUpdate, "model" | "effort">,
  ): Promise<AgentKernelPatchResult> {
    if (closed) return Promise.reject(new AgentConfigError("runtime_unavailable"));
    if (activeOperation !== null) {
      return Promise.reject(new AgentConfigError("agent_config_conflict"));
    }
    const pending = performKernelUpdate(patch);
    activeOperation = pending;
    const clearPending = () => {
      if (activeOperation === pending) activeOperation = null;
    };
    void pending.then(clearPending, clearPending);
    return pending;
  }

  async function performReconcile(): Promise<void> {
    if (closed) return;
    const probeDeadline = deadlineSignal(Math.min(timeoutMs, 2_000));
    let releaseLock: (() => Promise<void>) | null = null;
    try {
      await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
      let staleLock;
      try {
        staleLock = await lstat(lockPath);
      } catch (error) {
        if (!isErrno(error, "ENOENT")) {
          console.warn(
            "[agent-config] Runtime reconciliation lock check failed:",
            error instanceof Error ? error.name : "UnknownError",
          );
          return;
        }
      }
      if (staleLock?.isSymbolicLink()) {
        console.warn("[agent-config] Ignoring untrusted runtime transition lock");
        return;
      }
      if (staleLock !== undefined) {
        if (!staleLock.isFile()) {
          console.warn("[agent-config] Ignoring invalid runtime transition lock");
          return;
        }
        await unlink(lockPath).catch((error: unknown) => {
          if (!isErrno(error, "ENOENT")) throw error;
        });
      }

      releaseLock = await acquireLock(lockPath);
      await validateStartupTransitionMarker(transitionPath);
      const config = await readConfig(configPath);
      const agent = readAgentConfig(config);
      const selected = agent.value.messagingRuntime ?? "hermes";
      const selectedAdapter = options.adapters[selected];
      if (!selectedAdapter) {
        await pauseDelivery(probeDeadline.signal);
        return;
      }

      let selectedHealthy = false;
      try {
        const descriptor = AgentRuntimeDescriptorSchema.parse(
          await selectedAdapter.probe(probeDeadline.signal),
        );
        selectedHealthy = descriptor.health === "healthy";
      } catch (error) {
        console.warn(
          "[agent-config] Selected runtime reconciliation probe failed:",
          error instanceof Error ? error.name : "UnknownError",
        );
      }

      await pauseDelivery(probeDeadline.signal);
      if (selectedHealthy) {
        for (const [id, adapter] of Object.entries(options.adapters)) {
          if (id !== selected) {
            await adapter?.deactivate(probeDeadline.signal).catch((error: unknown) => {
              logBestEffortFailure("Inactive runtime reconciliation failed", error);
            });
          }
        }
        await selectedAdapter.activate(probeDeadline.signal);
        await resumeDelivery(selected, probeDeadline.signal);
      } else {
        for (const adapter of Object.values(options.adapters)) {
          await adapter?.deactivate(probeDeadline.signal).catch((error: unknown) => {
            logBestEffortFailure("Unavailable runtime deactivation failed", error);
          });
        }
      }
    } catch (error) {
      console.warn(
        "[agent-config] Runtime reconciliation failed:",
        error instanceof Error ? error.name : "UnknownError",
      );
      await pauseDelivery(probeDeadline.signal).catch((pauseError: unknown) => {
        logBestEffortFailure("Delivery reconciliation pause failed", pauseError);
      });
    } finally {
      probeDeadline.close();
      if (releaseLock === null) return;
      let transitionStat;
      try {
        transitionStat = await lstat(transitionPath);
      } catch (error) {
        if (!isErrno(error, "ENOENT")) {
          console.warn(
            "[agent-config] Transition marker cleanup failed:",
            error instanceof Error ? error.name : "UnknownError",
          );
        }
      }
      if (transitionStat?.isFile()) {
        await unlink(transitionPath).catch((error: unknown) => {
          if (!isErrno(error, "ENOENT")) {
            logBestEffortFailure("Transition marker cleanup failed", error);
          }
        });
      }
      await releaseLock().catch((error: unknown) => {
        logBestEffortFailure("Runtime reconciliation lock release failed", error);
      });
    }
  }

  function reconcile(): Promise<void> {
    if (closed) return Promise.resolve();
    if (activeOperation !== null) {
      return Promise.reject(new AgentConfigError("agent_config_conflict"));
    }
    const pending = performReconcile();
    activeOperation = pending;
    const clearPending = () => {
      if (activeOperation === pending) activeOperation = null;
    };
    void pending.then(clearPending, clearPending);
    return pending;
  }

  return {
    update,
    updateKernel,
    reconcile,
    close() {
      if (closePromise !== null) return closePromise;
      closed = true;
      activeAbort?.();
      closePromise = (async () => {
        await activeOperation?.catch((error: unknown) => {
          logBestEffortFailure("Active agent config operation stopped", error);
        });
        await Promise.all(Object.values(options.adapters).map(async (adapter) => {
          await adapter?.close();
        }));
      })();
      return closePromise;
    },
  };
}
