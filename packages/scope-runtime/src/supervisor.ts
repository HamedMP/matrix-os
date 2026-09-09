import { randomBytes } from "node:crypto";
import {
  RuntimeHandleSchema,
  ScopeRuntimeRequestSchema,
  ScopeRuntimeResponseSchema,
  type ScopeRuntimeCapabilityProfile,
  type ScopeRuntimeRequest,
  type ScopeRuntimeResponse,
} from "./protocol.js";
import {
  SCOPE_RUNTIME_HARNESS_VERSION,
  SCOPE_RUNTIME_PROFILE_DIGEST,
  SCOPE_RUNTIME_PROFILE_ID,
  SCOPE_RUNTIME_PROFILE_VERSION,
} from "./profile.js";

export const SCOPE_RUNTIME_SUPERVISOR_VERSION = "1.0.0";

export const SCOPE_RUNTIME_PROFILE: Omit<ScopeRuntimeCapabilityProfile, "executionGeneration"> = {
  profileId: SCOPE_RUNTIME_PROFILE_ID,
  profileVersion: SCOPE_RUNTIME_PROFILE_VERSION,
  profileDigest: SCOPE_RUNTIME_PROFILE_DIGEST,
  identity: { mode: "dynamic", uidMin: 61_184, uidMax: 65_519 },
  limits: {
    memoryMaxBytes: 1_073_741_824,
    cpuQuotaPercent: 200,
    tasksMax: 256,
    storageMaxBytes: 10_737_418_240,
  },
  adapters: [{
    adapterId: "claude-code",
    harnessVersion: SCOPE_RUNTIME_HARNESS_VERSION,
    workloads: ["chat_ai"],
  }],
};

export interface ScopeRuntimeLaunchRequest {
  runtimeHandle: string;
  scopeHandle: string;
  workload: "chat_ai" | "terminal";
  adapterId: string;
  harnessVersion: string;
}

export interface ScopeRuntimeLauncher {
  list(): Promise<string[]>;
  start(input: ScopeRuntimeLaunchRequest): Promise<void>;
  stop(runtimeHandle: string): Promise<void>;
}

function newRuntimeHandle(): string {
  return `runtime_${randomBytes(16).toString("hex")}`;
}

function runtimeFailure(
  requestId: string,
  error: "profile_unavailable" | "adapter_unavailable" | "capacity_exceeded"
    | "runtime_not_found" | "runtime_unavailable",
): ScopeRuntimeResponse {
  return ScopeRuntimeResponseSchema.parse({
    version: 1,
    type: "runtime.result",
    requestId,
    ok: false,
    error,
  });
}

export async function createScopeRuntimeController(options: {
  launcher: ScopeRuntimeLauncher;
  executionGeneration: string;
  maxRuntimes?: number;
  createRuntimeHandle?: () => string;
}) {
  const maxRuntimes = Math.max(1, Math.min(Math.trunc(options.maxRuntimes ?? 32), 32));
  const createRuntimeHandle = options.createRuntimeHandle ?? newRuntimeHandle;
  const existing = await options.launcher.list();
  if (existing.length > maxRuntimes) throw new Error("Scope runtime reconciliation exceeds capacity");
  const runtimes = new Set<string>();
  for (const value of existing) {
    const runtimeHandle = RuntimeHandleSchema.parse(value);
    if (runtimes.has(runtimeHandle)) throw new Error("Duplicate reconciled scope runtime");
    runtimes.add(runtimeHandle);
  }
  const operations = new Set<Promise<void>>();
  let reservedCreates = 0;
  let closed = false;

  async function createRuntime(
    request: Extract<ScopeRuntimeRequest, { type: "runtime.create" }>,
  ): Promise<ScopeRuntimeResponse> {
    if (request.profileId !== SCOPE_RUNTIME_PROFILE.profileId) {
      return runtimeFailure(request.requestId, "profile_unavailable");
    }
    const adapter = SCOPE_RUNTIME_PROFILE.adapters.find((candidate) =>
      candidate.adapterId === request.adapterId
      && candidate.harnessVersion === request.harnessVersion
      && candidate.workloads.includes(request.workload));
    if (!adapter) return runtimeFailure(request.requestId, "adapter_unavailable");
    if (runtimes.size + reservedCreates >= maxRuntimes) {
      return runtimeFailure(request.requestId, "capacity_exceeded");
    }

    let runtimeHandle: string | undefined;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const candidate = RuntimeHandleSchema.parse(createRuntimeHandle());
      if (!runtimes.has(candidate)) {
        runtimeHandle = candidate;
        break;
      }
    }
    if (!runtimeHandle) return runtimeFailure(request.requestId, "runtime_unavailable");

    reservedCreates += 1;
    const operation = options.launcher.start({
      runtimeHandle,
      scopeHandle: request.scopeHandle,
      workload: request.workload,
      adapterId: request.adapterId,
      harnessVersion: request.harnessVersion,
    });
    operations.add(operation);
    try {
      await operation;
      if (closed) {
        try {
          await options.launcher.stop(runtimeHandle);
        } catch (error: unknown) {
          console.warn("[scope-runtime] post-close runtime cleanup failed:",
            error instanceof Error ? error.name : "UnknownError");
        }
        return runtimeFailure(request.requestId, "runtime_unavailable");
      }
      runtimes.add(runtimeHandle);
      return ScopeRuntimeResponseSchema.parse({
        version: 1,
        type: "runtime.result",
        requestId: request.requestId,
        ok: true,
        runtimeHandle,
        executionGeneration: options.executionGeneration,
        state: "running",
      });
    } catch (error: unknown) {
      console.warn("[scope-runtime] fixed-profile launch failed:",
        error instanceof Error ? error.name : "UnknownError");
      return runtimeFailure(request.requestId, "runtime_unavailable");
    } finally {
      reservedCreates -= 1;
      operations.delete(operation);
    }
  }

  async function stopRuntime(
    request: Extract<ScopeRuntimeRequest, { type: "runtime.stop" }>,
  ): Promise<ScopeRuntimeResponse> {
    if (!runtimes.has(request.runtimeHandle)) {
      return runtimeFailure(request.requestId, "runtime_not_found");
    }
    try {
      await options.launcher.stop(request.runtimeHandle);
      runtimes.delete(request.runtimeHandle);
      return ScopeRuntimeResponseSchema.parse({
        version: 1,
        type: "runtime.result",
        requestId: request.requestId,
        ok: true,
        runtimeHandle: request.runtimeHandle,
        executionGeneration: options.executionGeneration,
        state: "stopped",
      });
    } catch (error: unknown) {
      console.warn("[scope-runtime] fixed-profile stop failed:",
        error instanceof Error ? error.name : "UnknownError");
      return runtimeFailure(request.requestId, "runtime_unavailable");
    }
  }

  return {
    async handle(input: ScopeRuntimeRequest): Promise<ScopeRuntimeResponse> {
      const request = ScopeRuntimeRequestSchema.parse(input);
      if (closed) {
        return request.type === "capability.get"
          ? ScopeRuntimeResponseSchema.parse({
              version: 1,
              type: "capability.result",
              requestId: request.requestId,
              ok: false,
              error: "runtime_unavailable",
            })
          : runtimeFailure(request.requestId, "runtime_unavailable");
      }
      if (request.type === "capability.get") {
        return ScopeRuntimeResponseSchema.parse({
          version: 1,
          type: "capability.result",
          requestId: request.requestId,
          ok: true,
          supervisorVersion: SCOPE_RUNTIME_SUPERVISOR_VERSION,
          profile: { ...SCOPE_RUNTIME_PROFILE, executionGeneration: options.executionGeneration },
        });
      }
      return request.type === "runtime.create"
        ? createRuntime(request)
        : stopRuntime(request);
    },
    size(): number {
      return runtimes.size;
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await Promise.allSettled([...operations]);
      const stops = [...runtimes].map(async (runtimeHandle) => {
        try {
          await options.launcher.stop(runtimeHandle);
        } catch (error: unknown) {
          console.warn("[scope-runtime] shutdown stop failed:",
            error instanceof Error ? error.name : "UnknownError");
        } finally {
          runtimes.delete(runtimeHandle);
        }
      });
      await Promise.all(stops);
    },
  };
}
