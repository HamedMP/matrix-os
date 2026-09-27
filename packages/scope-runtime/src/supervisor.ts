import { randomBytes } from "node:crypto";
import {
  RuntimeHandleSchema,
  ScopeRuntimeRequestSchema,
  ScopeRuntimeResponseSchema,
  type ScopeRuntimeBotCommand,
  type ScopeRuntimeBotWorkerReply,
  type ScopeRuntimeCapabilityProfile,
  type ScopeRuntimeRequest,
  type ScopeRuntimeResponse,
  type ScopeRuntimeSandboxManifest,
  type ScopeRuntimeWorkload,
} from "./protocol.js";
import {
  SCOPE_RUNTIME_BOT_ADAPTER_ID,
  SCOPE_RUNTIME_BOT_HARNESS_VERSION,
  SCOPE_RUNTIME_BOT_PROFILE_DIGEST,
  SCOPE_RUNTIME_BOT_PROFILE_ID,
  SCOPE_RUNTIME_BOT_PROFILE_VERSION,
} from "./bot-profile.js";
import { SCOPE_RUNTIME_SANDBOX_CAPABILITY } from "./sandbox.js";
import {
  SCOPE_RUNTIME_HARNESS_VERSION,
  SCOPE_RUNTIME_CODEX_VERSION,
  SCOPE_RUNTIME_PROFILE_DIGEST,
  SCOPE_RUNTIME_PROFILE_ID,
  SCOPE_RUNTIME_PROFILE_VERSION,
} from "./profile.js";

export const SCOPE_RUNTIME_SUPERVISOR_VERSION = "1.0.0";
const EXECUTION_GENERATION = /^(0|[1-9][0-9]{0,19})$/;

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
  }, {
    adapterId: "codex",
    harnessVersion: SCOPE_RUNTIME_CODEX_VERSION,
    workloads: ["chat_ai"],
  }],
  sandbox: {
    policyVersion: SCOPE_RUNTIME_SANDBOX_CAPABILITY.policyVersion,
    policyDigest: SCOPE_RUNTIME_SANDBOX_CAPABILITY.policyDigest,
    workloads: ["chat_ai"],
  },
};

/**
 * The bot profile: the same identity, caps, and sandbox policy as the chat
 * profile, with the `matrix-bot` adapter as its only adapter.
 */
export const SCOPE_RUNTIME_BOT_PROFILE: Omit<ScopeRuntimeCapabilityProfile, "executionGeneration"> = {
  ...SCOPE_RUNTIME_PROFILE,
  profileId: SCOPE_RUNTIME_BOT_PROFILE_ID,
  profileVersion: SCOPE_RUNTIME_BOT_PROFILE_VERSION,
  profileDigest: SCOPE_RUNTIME_BOT_PROFILE_DIGEST,
  adapters: [{
    adapterId: SCOPE_RUNTIME_BOT_ADAPTER_ID,
    harnessVersion: SCOPE_RUNTIME_BOT_HARNESS_VERSION,
    workloads: ["bot_agent"],
  }],
  sandbox: {
    policyVersion: SCOPE_RUNTIME_SANDBOX_CAPABILITY.policyVersion,
    policyDigest: SCOPE_RUNTIME_SANDBOX_CAPABILITY.policyDigest,
    workloads: ["bot_agent"],
  },
};

export const SCOPE_RUNTIME_PROFILES = [SCOPE_RUNTIME_PROFILE, SCOPE_RUNTIME_BOT_PROFILE] as const;

export interface ScopeRuntimeLaunchRequest {
  runtimeHandle: string;
  scopeHandle: string;
  /** Absent means the shared-chat profile, for launchers that predate the catalog. */
  profileId?: string;
  workload: ScopeRuntimeWorkload;
  adapterId: string;
  harnessVersion: string;
  executionGeneration: string;
  /** S07: present for runs and terminals that act for a collaborator; absent for the owner's own fixed-profile runs. */
  sandbox?: ScopeRuntimeSandboxManifest;
}

export interface ScopeRuntimeReconciledRuntime {
  runtimeHandle: string;
  executionGeneration: string;
  /** Absent means the shared-chat profile. */
  profileId?: string;
}

export interface ScopeRuntimeLauncher {
  /** Adapters the host can launch for a profile (the shared-chat profile when omitted); empty disables it. */
  supportedAdapters?(profileId?: string): Promise<ScopeRuntimeCapabilityProfile["adapters"]>;
  list(): Promise<ScopeRuntimeReconciledRuntime[]>;
  /** Handles whose units are still running; read-only, unlike `list`, which also cleans up. */
  active?(): Promise<ReadonlySet<string>>;
  start(input: ScopeRuntimeLaunchRequest): Promise<void>;
  runChat(input: {
    runtimeHandle: string;
    executionGeneration: string;
    model: string;
    prompt: string;
  }): Promise<{ text: string }>;
  runBot?(input: {
    runtimeHandle: string;
    executionGeneration: string;
    command: ScopeRuntimeBotCommand;
  }): Promise<ScopeRuntimeBotWorkerReply>;
  stop(runtimeHandle: string): Promise<void>;
}

function newRuntimeHandle(): string {
  return `runtime_${randomBytes(16).toString("hex")}`;
}

function runtimeFailure(
  requestId: string,
  error: "invalid_request" | "profile_unavailable" | "adapter_unavailable" | "capacity_exceeded"
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

function botFailure(
  requestId: string,
  error: "invalid_request" | "runtime_not_found" | "runtime_unavailable" | "generation_mismatch" | "busy",
): ScopeRuntimeResponse {
  return ScopeRuntimeResponseSchema.parse({
    version: 1,
    type: "runtime.bot.result",
    requestId,
    ok: false,
    error,
  });
}

function chatFailure(
  requestId: string,
  error: "runtime_not_found" | "runtime_unavailable" | "generation_mismatch",
): ScopeRuntimeResponse {
  return ScopeRuntimeResponseSchema.parse({
    version: 1,
    type: "runtime.chat.result",
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
  if (!EXECUTION_GENERATION.test(options.executionGeneration)) {
    throw new Error("Invalid scope runtime execution generation");
  }
  const createRuntimeHandle = options.createRuntimeHandle ?? newRuntimeHandle;
  const availableProfiles: Omit<ScopeRuntimeCapabilityProfile, "executionGeneration">[] = [];
  for (const profile of SCOPE_RUNTIME_PROFILES) {
    const adapters = options.launcher.supportedAdapters
      ? await options.launcher.supportedAdapters(profile.profileId)
      : profile === SCOPE_RUNTIME_PROFILE ? profile.adapters : [];
    // The shared-chat profile is always advertised; others only when the host can launch them.
    if (profile === SCOPE_RUNTIME_PROFILE || adapters.length > 0) availableProfiles.push({ ...profile, adapters });
  }
  const availableProfile = availableProfiles[0]!;
  const existing = await options.launcher.list();
  if (existing.length > maxRuntimes) throw new Error("Scope runtime reconciliation exceeds capacity");
  const runtimes = new Map<string, { executionGeneration: string; profileId: string }>();
  for (const value of existing) {
    const runtimeHandle = RuntimeHandleSchema.parse(value.runtimeHandle);
    if (!EXECUTION_GENERATION.test(value.executionGeneration)) {
      throw new Error("Invalid reconciled scope runtime generation");
    }
    if (runtimes.has(runtimeHandle)) throw new Error("Duplicate reconciled scope runtime");
    runtimes.set(runtimeHandle, {
      executionGeneration: value.executionGeneration,
      profileId: value.profileId ?? SCOPE_RUNTIME_PROFILE.profileId,
    });
  }
  const operations = new Set<Promise<void>>();
  let reservedCreates = 0;
  let closed = false;

  /**
   * Units end on their own (RuntimeMaxSec, crash, or worker exit). Drops map
   * entries whose unit is no longer running, so exited runtimes stop holding
   * capacity. Read-only on the host side.
   */
  async function pruneExited(): Promise<void> {
    if (!options.launcher.active) return;
    try {
      const running = await options.launcher.active();
      for (const runtimeHandle of runtimes.keys()) {
        if (!running.has(runtimeHandle)) runtimes.delete(runtimeHandle);
      }
    } catch (error: unknown) {
      console.warn("[scope-runtime] runtime liveness check failed:",
        error instanceof Error ? error.name : "UnknownError");
    }
  }

  async function createRuntime(
    request: Extract<ScopeRuntimeRequest, { type: "runtime.create" }>,
  ): Promise<ScopeRuntimeResponse> {
    const profile = availableProfiles.find((candidate) => candidate.profileId === request.profileId);
    if (!profile) return runtimeFailure(request.requestId, "profile_unavailable");
    const adapter = profile.adapters.find((candidate) =>
      candidate.adapterId === request.adapterId
      && candidate.harnessVersion === request.harnessVersion
      && candidate.workloads.includes(request.workload));
    if (!adapter) return runtimeFailure(request.requestId, "adapter_unavailable");
    // A shared terminal only exists inside the sandbox; a bare terminal workload is never launched.
    if (request.workload === "terminal" && !request.sandbox) {
      return runtimeFailure(request.requestId, "invalid_request");
    }
    if (request.sandbox && !profile.sandbox?.workloads.includes(request.workload)) {
      return runtimeFailure(request.requestId, "adapter_unavailable");
    }
    // A bot always runs inside its own workspace root; there is no unsandboxed bot launch.
    if (request.workload === "bot_agent" && !request.sandbox) {
      return runtimeFailure(request.requestId, "invalid_request");
    }
    if (request.sandbox && request.sandbox.scopeHandle !== request.scopeHandle) {
      return runtimeFailure(request.requestId, "invalid_request");
    }
    if (runtimes.size + reservedCreates >= maxRuntimes) await pruneExited();
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
      profileId: profile.profileId,
      workload: request.workload,
      adapterId: request.adapterId,
      harnessVersion: request.harnessVersion,
      executionGeneration: options.executionGeneration,
      ...(request.sandbox ? { sandbox: request.sandbox } : {}),
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
      runtimes.set(runtimeHandle, { executionGeneration: options.executionGeneration, profileId: profile.profileId });
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
    const executionGeneration = runtimes.get(request.runtimeHandle)?.executionGeneration;
    if (executionGeneration === undefined) {
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
        executionGeneration,
        state: "stopped",
      });
    } catch (error: unknown) {
      console.warn("[scope-runtime] fixed-profile stop failed:",
        error instanceof Error ? error.name : "UnknownError");
      return runtimeFailure(request.requestId, "runtime_unavailable");
    }
  }

  async function runChat(
    request: Extract<ScopeRuntimeRequest, { type: "runtime.chat" }>,
  ): Promise<ScopeRuntimeResponse> {
    const runtime = runtimes.get(request.runtimeHandle);
    if (runtime === undefined || runtime.profileId !== SCOPE_RUNTIME_PROFILE.profileId) {
      return chatFailure(request.requestId, "runtime_not_found");
    }
    const { executionGeneration } = runtime;
    if (executionGeneration !== request.executionGeneration) {
      return chatFailure(request.requestId, "generation_mismatch");
    }
    try {
      const result = await options.launcher.runChat({
        runtimeHandle: request.runtimeHandle,
        executionGeneration,
        model: request.model,
        prompt: request.prompt,
      });
      return ScopeRuntimeResponseSchema.parse({
        version: 1,
        type: "runtime.chat.result",
        requestId: request.requestId,
        ok: true,
        runtimeHandle: request.runtimeHandle,
        executionGeneration,
        text: result.text,
      });
    } catch (error: unknown) {
      console.warn("[scope-runtime] fixed-profile Chat failed:",
        error instanceof Error ? error.name : "UnknownError");
      return chatFailure(request.requestId, "runtime_unavailable");
    }
  }

  async function runBot(
    request: Extract<ScopeRuntimeRequest, { type: "runtime.bot" }>,
  ): Promise<ScopeRuntimeResponse> {
    const runtime = runtimes.get(request.runtimeHandle);
    if (runtime === undefined || runtime.profileId !== SCOPE_RUNTIME_BOT_PROFILE_ID || !options.launcher.runBot) {
      return botFailure(request.requestId, "runtime_not_found");
    }
    if (runtime.executionGeneration !== request.executionGeneration) {
      return botFailure(request.requestId, "generation_mismatch");
    }
    try {
      const result = await options.launcher.runBot({
        runtimeHandle: request.runtimeHandle,
        executionGeneration: runtime.executionGeneration,
        command: request.command,
      });
      if (!result.ok) {
        return botFailure(request.requestId, result.error === "busy" ? "busy"
          : result.error === "invalid_command" ? "invalid_request" : "runtime_unavailable");
      }
      return ScopeRuntimeResponseSchema.parse({
        version: 1,
        type: "runtime.bot.result",
        requestId: request.requestId,
        ok: true,
        runtimeHandle: request.runtimeHandle,
        executionGeneration: runtime.executionGeneration,
        reply: result.reply,
      });
    } catch (error: unknown) {
      console.warn("[scope-runtime] bot command failed:",
        error instanceof Error ? error.name : "UnknownError");
      await pruneExited();
      return botFailure(request.requestId, "runtime_unavailable");
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
          : request.type === "runtime.bot"
            ? botFailure(request.requestId, "runtime_unavailable")
            : runtimeFailure(request.requestId, "runtime_unavailable");
      }
      if (request.type === "capability.get") {
        return ScopeRuntimeResponseSchema.parse({
          version: 1,
          type: "capability.result",
          requestId: request.requestId,
          ok: true,
          supervisorVersion: SCOPE_RUNTIME_SUPERVISOR_VERSION,
          profile: { ...availableProfile, executionGeneration: options.executionGeneration },
          profiles: availableProfiles.map((profile) => ({ ...profile, executionGeneration: options.executionGeneration })),
        });
      }
      if (request.type === "runtime.create") return createRuntime(request);
      if (request.type === "runtime.chat") return runChat(request);
      if (request.type === "runtime.bot") return runBot(request);
      return stopRuntime(request);
    },
    size(): number {
      return runtimes.size;
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await Promise.allSettled([...operations]);
      const stops = [...runtimes.keys()].map(async (runtimeHandle) => {
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
