import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import {
  ScopeRuntimeRequestSchema,
  ScopeRuntimeResponseSchema,
  type ScopeRuntimeRequest,
  type ScopeRuntimeResponse,
} from "@matrix-os/scope-runtime";

const MAX_FRAME_BYTES = 128 * 1024;
const MAX_TIMEOUT_MS = 90_000;
const MAX_IN_FLIGHT_REQUESTS = 64;
const DEFAULT_OPERATION_TIMEOUT_MS = 60_000;

export interface ScopeRuntimeProfileCatalogEntry {
  profileVersion: number;
  profileDigest: string;
  identity: { mode: "dynamic"; uidMin: number; uidMax: number };
  supportedAdapters: Readonly<Record<string, Readonly<{
    harnessVersions: readonly string[];
    workloads: readonly ("chat_ai" | "terminal")[];
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
      workloads: Array<"chat_ai" | "terminal">;
    }>;
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

  function request(input: ScopeRuntimeRequest): Promise<ScopeRuntimeResponse> {
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
      const signal = AbortSignal.timeout(timeoutMs);
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
      socket.setTimeout(timeoutMs, fail);
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

  function supports(response: Extract<ScopeRuntimeResponse, { type: "capability.result"; ok: true }>): boolean {
    const expected = options.profileCatalog[response.profile.profileId];
    if (!expected || response.profile.identity.mode !== "dynamic"
      || response.profile.identity.uidMin !== expected.identity.uidMin
      || response.profile.identity.uidMax !== expected.identity.uidMax
      || expected.profileVersion !== response.profile.profileVersion
      || expected.profileDigest !== response.profile.profileDigest) return false;
    return response.profile.adapters.every((adapter) => {
      const supported = expected.supportedAdapters[adapter.adapterId];
      return supported?.harnessVersions.includes(adapter.harnessVersion) === true
        && adapter.workloads.every((workload) => supported.workloads.includes(workload));
    });
  }

  return {
    capability(): ScopeRuntimeCapability {
      return currentCapability;
    },
    async refreshCapability(): Promise<ScopeRuntimeCapability> {
      if (closed) throw new ScopeRuntimeClientError("client_closed");
      try {
        const response = await request({
          version: 1,
          type: "capability.get",
          requestId: createRequestId(),
        });
        if (response.type !== "capability.result" || !response.ok || !supports(response)) {
          currentCapability = { available: false, reason: "unsupported_profile" };
          return currentCapability;
        }
        currentCapability = {
          available: true,
          profileId: response.profile.profileId,
          executionGeneration: response.profile.executionGeneration,
          supportedAdapters: response.profile.adapters.map((entry) => ({
            adapterId: entry.adapterId,
            harnessVersion: entry.harnessVersion,
            workloads: [...entry.workloads],
          })),
        };
        return currentCapability;
      } catch (error: unknown) {
        if (!(error instanceof ScopeRuntimeClientError)) {
          console.warn("[collaboration] scope runtime capability failed");
        }
        currentCapability = { available: false, reason: "supervisor_unavailable" };
        return currentCapability;
      }
    },
    async createRuntime(input: {
      scopeHandle: string;
      workload: "chat_ai" | "terminal";
      adapterId: string;
      harnessVersion: string;
    }) {
      if (closed) throw new ScopeRuntimeClientError("client_closed");
      const capability = currentCapability;
      if (!capability.available) throw new ScopeRuntimeClientError("runtime_unavailable");
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
    },
  };
}
