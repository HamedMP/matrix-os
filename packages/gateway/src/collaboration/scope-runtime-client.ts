import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import {
  ScopeRuntimeRequestSchema,
  ScopeRuntimeResponseSchema,
  type ScopeRuntimeBotCommand,
  type ScopeRuntimeCapabilityProfile,
  type ScopeRuntimeRequest,
  type ScopeRuntimeResponse,
  type ScopeRuntimeSandboxManifest,
  type ScopeRuntimeWorkload,
} from "@matrix-os/scope-runtime";

const MAX_FRAME_BYTES = 128 * 1024;
const MAX_TIMEOUT_MS = 90_000;
const MAX_IN_FLIGHT_REQUESTS = 64;
const DEFAULT_OPERATION_TIMEOUT_MS = 60_000;
/** A relayed bot turn may run until the workload's 900 second lifetime ends. */
const BOT_RUN_TIMEOUT_MS = 935_000;
const BOT_CONTROL_TIMEOUT_MS = 20_000;

export interface ScopeRuntimeSandboxCapability {
  policyVersion: number;
  policyDigest: string;
  workloads: ScopeRuntimeWorkload[];
}

export interface ScopeRuntimeProfileCatalogEntry {
  profileVersion: number;
  profileDigest: string;
  identity: { mode: "dynamic"; uidMin: number; uidMax: number };
  /** S07: when set, the supervisor must advertise exactly this sandbox policy or the profile is unsupported. */
  sandbox?: { policyVersion: number; policyDigest: string };
  supportedAdapters: Readonly<Record<string, Readonly<{
    harnessVersions: readonly string[];
    workloads: readonly ScopeRuntimeWorkload[];
  }>>>;
}

export type ScopeRuntimeProfileCatalog = Readonly<Record<string, ScopeRuntimeProfileCatalogEntry>>;

export type ScopeRuntimeCapability =
  | {
    available: true;
    profileId: string;
    executionGeneration: string;
    supportedAdapters: Array<{
      adapterId: string;
      harnessVersion: string;
      workloads: ScopeRuntimeWorkload[];
    }>;
    /** Present only when the supervisor advertises a sandbox policy that matches the catalog. */
    sandbox?: ScopeRuntimeSandboxCapability;
  }
  | { available: false; reason: "supervisor_unavailable" | "unsupported_profile" };

export class ScopeRuntimeClientError extends Error {
  readonly code: "client_capacity" | "client_closed" | "runtime_unavailable";

  constructor(code: ScopeRuntimeClientError["code"]) {
    super(code === "client_closed"
      ? "Scope runtime client is closed"
      : code === "client_capacity"
        ? "Scope runtime client is at capacity"
        : "Scope runtime is unavailable");
    this.name = "ScopeRuntimeClientError";
    this.code = code;
  }
}

export function createScopeRuntimeClient(options: {
  socketPath: string;
  profileCatalog: ScopeRuntimeProfileCatalog;
  timeoutMs?: number;
  createRequestId?: () => string;
}) {
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(1, Math.min(Math.trunc(options.timeoutMs!), MAX_TIMEOUT_MS))
    : DEFAULT_OPERATION_TIMEOUT_MS;
  const createRequestId = options.createRequestId ?? randomUUID;
  const sockets = new Set<Socket>();
  const operations = new Set<Promise<unknown>>();
  let closed = false;
  let currentCapability: ScopeRuntimeCapability = {
    available: false,
    reason: "supervisor_unavailable",
  };
  /** Per-profile capabilities for every catalog profile; each fails closed on its own. */
  let profileCapabilities = new Map<string, ScopeRuntimeCapability>();

  function request(input: ScopeRuntimeRequest, requestTimeoutMs = timeoutMs): Promise<ScopeRuntimeResponse> {
    if (closed) return Promise.reject(new ScopeRuntimeClientError("client_closed"));
    if (operations.size >= MAX_IN_FLIGHT_REQUESTS) {
      return Promise.reject(new ScopeRuntimeClientError("client_capacity"));
    }
    const frame = `${JSON.stringify(ScopeRuntimeRequestSchema.parse(input))}\n`;
    if (Buffer.byteLength(frame, "utf8") > MAX_FRAME_BYTES) {
      return Promise.reject(new ScopeRuntimeClientError("runtime_unavailable"));
    }
    const operation = new Promise<ScopeRuntimeResponse>((resolve, reject) => {
      const socket = createConnection({ path: options.socketPath });
      const signal = AbortSignal.timeout(requestTimeoutMs);
      let response = "";
      let settled = false;
      sockets.add(socket);
      const cleanup = () => {
        signal.removeEventListener("abort", fail);
        sockets.delete(socket);
      };
      const fail = () => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.destroy();
        reject(new ScopeRuntimeClientError("runtime_unavailable"));
      };
      signal.addEventListener("abort", fail, { once: true });
      socket.setEncoding("utf8");
      socket.setTimeout(requestTimeoutMs, fail);
      socket.once("error", fail);
      socket.once("connect", () => socket.end(frame));
      socket.on("data", (chunk) => {
        response += chunk;
        if (Buffer.byteLength(response, "utf8") > MAX_FRAME_BYTES) fail();
      });
      socket.once("end", () => {
        if (settled) return;
        try {
          const parsed = ScopeRuntimeResponseSchema.parse(JSON.parse(response.trim()));
          if (parsed.requestId !== input.requestId) {
            fail();
            return;
          }
          settled = true;
          cleanup();
          resolve(parsed);
        } catch (error: unknown) {
          if (!(error instanceof SyntaxError)) {
            console.warn("[collaboration] scope runtime response validation failed");
          }
          fail();
        }
      });
      socket.once("close", () => {
        if (!settled) fail();
      });
    });
    operations.add(operation);
    void operation.finally(() => operations.delete(operation)).catch((error: unknown) => {
      if (!(error instanceof ScopeRuntimeClientError)) {
        console.warn("[collaboration] scope runtime operation cleanup failed");
      }
    });
    return operation;
  }

  function expected(profileId: string): ScopeRuntimeProfileCatalogEntry | undefined {
    return options.profileCatalog[profileId];
  }

  /** Exact match against the catalog: identity, version, digest, sandbox policy, and every adapter. */
  function supportsProfile(profile: ScopeRuntimeCapabilityProfile): boolean {
    const expected = options.profileCatalog[profile.profileId];
    if (!expected || profile.identity.mode !== "dynamic"
      || profile.identity.uidMin !== expected.identity.uidMin
      || profile.identity.uidMax !== expected.identity.uidMax
      || expected.profileVersion !== profile.profileVersion
      || expected.profileDigest !== profile.profileDigest) return false;
    if (expected.sandbox && (!profile.sandbox
      || profile.sandbox.policyVersion !== expected.sandbox.policyVersion
      || profile.sandbox.policyDigest !== expected.sandbox.policyDigest)) return false;
    return profile.adapters.every((adapter) => {
      const supported = expected.supportedAdapters[adapter.adapterId];
      return supported?.harnessVersions.includes(adapter.harnessVersion) === true
        && adapter.workloads.every((workload) => supported.workloads.includes(workload));
    });
  }

  function capabilityFor(profile: ScopeRuntimeCapabilityProfile): ScopeRuntimeCapability {
    if (!supportsProfile(profile)) return { available: false, reason: "unsupported_profile" };
    return {
      available: true,
      profileId: profile.profileId,
      executionGeneration: profile.executionGeneration,
      supportedAdapters: profile.adapters.map((entry) => ({
        adapterId: entry.adapterId,
        harnessVersion: entry.harnessVersion,
        workloads: [...entry.workloads],
      })),
      ...(profile.sandbox && expected(profile.profileId)?.sandbox
        ? { sandbox: {
            policyVersion: profile.sandbox.policyVersion,
            policyDigest: profile.sandbox.policyDigest,
            workloads: [...profile.sandbox.workloads],
          } }
        : {}),
    };
  }

  function capabilityOfProfile(profileId: string): ScopeRuntimeCapability {
    return profileCapabilities.get(profileId) ?? (currentCapability.available
      ? { available: false, reason: "unsupported_profile" }
      : currentCapability);
  }

  return {
    capability(): ScopeRuntimeCapability {
      return currentCapability;
    },
    /** A catalog profile's capability; profiles the supervisor does not advertise are unsupported. */
    profileCapability: capabilityOfProfile,
    async refreshCapability(): Promise<ScopeRuntimeCapability> {
      if (closed) throw new ScopeRuntimeClientError("client_closed");
      try {
        const response = await request({
          version: 1,
          type: "capability.get",
          requestId: createRequestId(),
        });
        if (response.type !== "capability.result" || !response.ok) {
          currentCapability = { available: false, reason: "unsupported_profile" };
          profileCapabilities = new Map();
          return currentCapability;
        }
        currentCapability = capabilityFor(response.profile);
        const advertised = response.profiles ?? [response.profile];
        const next = new Map<string, ScopeRuntimeCapability>();
        for (const profileId of Object.keys(options.profileCatalog)) {
          const profile = advertised.find((entry) => entry.profileId === profileId);
          next.set(profileId, profile ? capabilityFor(profile) : { available: false, reason: "unsupported_profile" });
        }
        profileCapabilities = next;
        return currentCapability;
      } catch (error: unknown) {
        if (!(error instanceof ScopeRuntimeClientError)) {
          console.warn("[collaboration] scope runtime capability failed");
        }
        currentCapability = { available: false, reason: "supervisor_unavailable" };
        profileCapabilities = new Map();
        return currentCapability;
      }
    },
    async createRuntime(input: {
      scopeHandle: string;
      /** A catalog profile other than the shared-chat one, e.g. the bot profile. */
      profileId?: string;
      workload: ScopeRuntimeWorkload;
      adapterId: string;
      harnessVersion: string;
      /** S07: required for any run or terminal that acts for a collaborator, and for every bot. */
      sandbox?: ScopeRuntimeSandboxManifest;
    }) {
      if (closed) throw new ScopeRuntimeClientError("client_closed");
      const capability = input.profileId === undefined ? currentCapability : capabilityOfProfile(input.profileId);
      if (!capability.available) throw new ScopeRuntimeClientError("runtime_unavailable");
      if (input.sandbox && (!capability.sandbox || !capability.sandbox.workloads.includes(input.workload)
        || input.sandbox.scopeHandle !== input.scopeHandle)) {
        throw new ScopeRuntimeClientError("runtime_unavailable");
      }
      // Every call through this client is sandboxed: a shared run or a private bot.
      // A caller cannot opt into the owner's wider fixed profile by omitting a manifest.
      if (!input.sandbox) throw new ScopeRuntimeClientError("runtime_unavailable");
      const adapter = capability.supportedAdapters.find((entry) => entry.adapterId === input.adapterId);
      if (!adapter || adapter.harnessVersion !== input.harnessVersion
        || !adapter.workloads.includes(input.workload)) {
        throw new ScopeRuntimeClientError("runtime_unavailable");
      }
      const response = await request({
        version: 1,
        type: "runtime.create",
        requestId: createRequestId(),
        scopeHandle: input.scopeHandle,
        profileId: capability.profileId,
        workload: input.workload,
        adapterId: input.adapterId,
        harnessVersion: input.harnessVersion,
        ...(input.sandbox ? { sandbox: input.sandbox } : {}),
      });
      if (response.type !== "runtime.result" || !response.ok || response.state !== "running") {
        throw new ScopeRuntimeClientError("runtime_unavailable");
      }
      return {
        runtimeHandle: response.runtimeHandle,
        executionGeneration: response.executionGeneration,
        state: response.state,
      };
    },
    /**
     * Relays a bot command to a `bot_agent` worker. `bot.run` holds the call
     * until the turn ends; steer and cancel answer quickly. The reply is
     * opaque here and validated by the caller against the bot contracts.
     */
    async runBot(input: { runtimeHandle: string; executionGeneration: string; command: ScopeRuntimeBotCommand }) {
      if (closed) throw new ScopeRuntimeClientError("client_closed");
      const response = await request({
        version: 1,
        type: "runtime.bot",
        requestId: createRequestId(),
        runtimeHandle: input.runtimeHandle,
        executionGeneration: input.executionGeneration,
        command: input.command,
      }, input.command.kind === "bot.run" ? BOT_RUN_TIMEOUT_MS : BOT_CONTROL_TIMEOUT_MS);
      if (response.type !== "runtime.bot.result") throw new ScopeRuntimeClientError("runtime_unavailable");
      if (!response.ok) {
        return { ok: false as const, error: response.error };
      }
      if (response.runtimeHandle !== input.runtimeHandle || response.executionGeneration !== input.executionGeneration) {
        throw new ScopeRuntimeClientError("runtime_unavailable");
      }
      return { ok: true as const, reply: response.reply };
    },
    async stopRuntime(input: { runtimeHandle: string }) {
      if (closed) throw new ScopeRuntimeClientError("client_closed");
      const response = await request({
        version: 1,
        type: "runtime.stop",
        requestId: createRequestId(),
        runtimeHandle: input.runtimeHandle,
      });
      if (response.type !== "runtime.result" || !response.ok || response.state !== "stopped") {
        throw new ScopeRuntimeClientError("runtime_unavailable");
      }
      return {
        runtimeHandle: response.runtimeHandle,
        executionGeneration: response.executionGeneration,
        state: response.state,
      };
    },
    async runChat(input: {
      runtimeHandle: string;
      executionGeneration: string;
      model: string;
      prompt: string;
    }) {
      if (closed) throw new ScopeRuntimeClientError("client_closed");
      const capability = currentCapability;
      if (!capability.available || capability.executionGeneration !== input.executionGeneration) {
        throw new ScopeRuntimeClientError("runtime_unavailable");
      }
      const response = await request({
        version: 1,
        type: "runtime.chat",
        requestId: createRequestId(),
        runtimeHandle: input.runtimeHandle,
        executionGeneration: input.executionGeneration,
        model: input.model,
        prompt: input.prompt,
      });
      if (response.type !== "runtime.chat.result" || !response.ok
        || response.runtimeHandle !== input.runtimeHandle
        || response.executionGeneration !== input.executionGeneration) {
        throw new ScopeRuntimeClientError("runtime_unavailable");
      }
      return {
        runtimeHandle: response.runtimeHandle,
        executionGeneration: response.executionGeneration,
        text: response.text,
      };
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      await Promise.allSettled([...operations]);
      currentCapability = { available: false, reason: "supervisor_unavailable" };
      profileCapabilities = new Map();
    },
  };
}
