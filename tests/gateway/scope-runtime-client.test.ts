import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ScopeRuntimeRequestSchema,
  type ScopeRuntimeResponse,
} from "../../packages/scope-runtime/src/protocol.js";
import {
  ScopeRuntimeClientError,
  createScopeRuntimeClient,
  type ScopeRuntimeProfileCatalog,
} from "../../packages/gateway/src/collaboration/scope-runtime-client.js";

const PROFILE_DIGEST = "db0bcb5905e1543f87fcd81de4f44e80be89116aaf54fd98a502874f06e91738";
const REQUEST_ID = "018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1";
const SCOPE_HANDLE = "scope_11111111111111111111111111111111";
const RUNTIME_HANDLE = "runtime_22222222222222222222222222222222";
const catalog: ScopeRuntimeProfileCatalog = {
  "scope-runtime-proof-v1": {
    profileVersion: 1,
    profileDigest: PROFILE_DIGEST,
    identity: { mode: "dynamic", uidMin: 61_184, uidMax: 65_519 },
    supportedAdapters: {
      "claude-code": { harnessVersions: ["2.1.240"], workloads: ["chat_ai"] },
    },
  },
};

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(cleanup.splice(0).map((remove) => remove()));
});

async function socketPath(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return join(root, "scope-runtime.sock");
}

async function listen(
  path: string,
  respond: (frame: unknown, socket: Socket) => ScopeRuntimeResponse | undefined,
): Promise<{ frames: unknown[]; close(): Promise<void> }> {
  await mkdir(dirname(path), { recursive: true });
  const frames: unknown[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk;
    });
    socket.on("end", () => {
      const frame = JSON.parse(input) as unknown;
      frames.push(frame);
      const response = respond(frame, socket);
      if (response) socket.end(`${JSON.stringify(response)}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  cleanup.push(close);
  return { frames, close };
}

function capabilityResponse(requestId = REQUEST_ID): ScopeRuntimeResponse {
  return {
    version: 1,
    type: "capability.result",
    requestId,
    ok: true,
    supervisorVersion: "1.0.0",
    profile: {
      profileId: "scope-runtime-proof-v1",
      profileVersion: 1,
      profileDigest: PROFILE_DIGEST,
      executionGeneration: "1",
      identity: { mode: "dynamic", uidMin: 61_184, uidMax: 65_519 },
      limits: {
        memoryMaxBytes: 1_073_741_824,
        cpuQuotaPercent: 200,
        tasksMax: 256,
        storageMaxBytes: 10_737_418_240,
      },
      adapters: [{ adapterId: "claude-code", harnessVersion: "2.1.240", workloads: ["chat_ai"] }],
    },
  };
}

describe("scope runtime protocol", () => {
  it("accepts only opaque fixed-profile requests and rejects injection fields", () => {
    expect(ScopeRuntimeRequestSchema.parse({
      version: 1,
      type: "runtime.create",
      requestId: REQUEST_ID,
      scopeHandle: SCOPE_HANDLE,
      profileId: "scope-runtime-proof-v1",
      workload: "chat_ai",
      adapterId: "claude-code",
      harnessVersion: "2.1.240",
    })).toEqual(expect.objectContaining({ scopeHandle: SCOPE_HANDLE }));

    for (const injected of [
      { command: "/bin/sh" },
      { environment: { OWNER_TOKEN: "secret" } },
      { hostPath: "/home/matrix/home" },
      { unitProperties: { BindPaths: "/" } },
      { uid: 0 },
    ]) {
      expect(ScopeRuntimeRequestSchema.safeParse({
        version: 1,
        type: "runtime.create",
        requestId: REQUEST_ID,
        scopeHandle: SCOPE_HANDLE,
        profileId: "scope-runtime-proof-v1",
        workload: "chat_ai",
        adapterId: "claude-code",
        harnessVersion: "2.1.240",
        ...injected,
      }).success).toBe(false);
    }
  });
});

describe("scope runtime client", () => {
  it("advertises capability only for the exact measured profile and harness", async () => {
    const path = await socketPath("matrix-scope-client-");
    const server = await listen(path, (frame) => {
      const request = ScopeRuntimeRequestSchema.parse(frame);
      expect(request.type).toBe("capability.get");
      return capabilityResponse(request.requestId);
    });
    const client = createScopeRuntimeClient({
      socketPath: path,
      profileCatalog: catalog,
      timeoutMs: 1_000,
      createRequestId: () => REQUEST_ID,
    });

    await expect(client.refreshCapability()).resolves.toMatchObject({
      available: true,
      profileId: "scope-runtime-proof-v1",
      executionGeneration: "1",
      supportedAdapters: [{
        adapterId: "claude-code",
        harnessVersion: "2.1.240",
        workloads: ["chat_ai"],
      }],
    });
    expect(client.capability()).toEqual(expect.objectContaining({ available: true }));
    expect(server.frames).toHaveLength(1);
    await client.close();
  });

  it.each([
    ["unknown profile", { profile: { profileId: "scope-runtime-proof-v2" } }],
    ["changed profile digest", { profile: { profileDigest: "b".repeat(64) } }],
    ["unmeasured harness", { profile: { adapters: [{ adapterId: "claude-code", harnessVersion: "2.1.33", workloads: ["chat_ai"] }] } }],
    ["root workload", { profile: { identity: { mode: "static", uid: 0 } } }],
  ])("fails closed for %s", async (_label, replacement) => {
    const path = await socketPath("matrix-scope-profile-");
    await listen(path, (frame) => {
      const request = ScopeRuntimeRequestSchema.parse(frame);
      const response = capabilityResponse(request.requestId);
      if (response.type !== "capability.result" || !response.ok) return response;
      return {
        ...response,
        profile: { ...response.profile, ...replacement.profile },
      } as ScopeRuntimeResponse;
    });
    const client = createScopeRuntimeClient({
      socketPath: path,
      profileCatalog: catalog,
      timeoutMs: 1_000,
      createRequestId: () => REQUEST_ID,
    });

    await expect(client.refreshCapability()).resolves.toEqual({
      available: false,
      reason: "unsupported_profile",
    });
    await expect(client.createRuntime({
      scopeHandle: SCOPE_HANDLE,
      workload: "chat_ai",
      adapterId: "claude-code",
      harnessVersion: "2.1.240",
    })).rejects.toBeInstanceOf(ScopeRuntimeClientError);
    await client.close();
  });

  it("does not advertise the unproven terminal workload", async () => {
    const path = await socketPath("matrix-scope-workload-");
    await listen(path, (frame) => capabilityResponse(ScopeRuntimeRequestSchema.parse(frame).requestId));
    const client = createScopeRuntimeClient({
      socketPath: path,
      profileCatalog: catalog,
      timeoutMs: 1_000,
      createRequestId: () => REQUEST_ID,
    });
    await client.refreshCapability();

    await expect(client.createRuntime({
      scopeHandle: SCOPE_HANDLE,
      workload: "terminal",
      adapterId: "claude-code",
      harnessVersion: "2.1.240",
    })).rejects.toBeInstanceOf(ScopeRuntimeClientError);
    await client.close();
  });

  it("creates and stops by opaque handle without caller-controlled host configuration", async () => {
    const path = await socketPath("matrix-scope-operations-");
    const server = await listen(path, (frame) => {
      const request = ScopeRuntimeRequestSchema.parse(frame);
      if (request.type === "capability.get") return capabilityResponse(request.requestId);
      if (request.type === "runtime.create") {
        return {
          version: 1,
          type: "runtime.result",
          requestId: request.requestId,
          ok: true,
          runtimeHandle: RUNTIME_HANDLE,
          executionGeneration: "1",
          state: "running",
        };
      }
      return {
        version: 1,
        type: "runtime.result",
        requestId: request.requestId,
        ok: true,
        runtimeHandle: request.runtimeHandle,
        executionGeneration: "1",
        state: "stopped",
      };
    });
    let sequence = 0;
    const client = createScopeRuntimeClient({
      socketPath: path,
      profileCatalog: catalog,
      timeoutMs: 1_000,
      createRequestId: () => sequence++ === 0
        ? REQUEST_ID
        : `018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d${sequence}`,
    });
    await client.refreshCapability();
    await expect(client.createRuntime({
      scopeHandle: SCOPE_HANDLE,
      workload: "chat_ai",
      adapterId: "claude-code",
      harnessVersion: "2.1.240",
    })).resolves.toEqual({
      runtimeHandle: RUNTIME_HANDLE,
      executionGeneration: "1",
      state: "running",
    });
    await expect(client.stopRuntime({ runtimeHandle: RUNTIME_HANDLE })).resolves.toEqual({
      runtimeHandle: RUNTIME_HANDLE,
      executionGeneration: "1",
      state: "stopped",
    });
    expect(JSON.stringify(server.frames)).not.toMatch(/\/home|command|environment|unitProperties/);
    await client.close();
  });

  it("uses deadlines, survives a supervisor restart, and drains in-flight requests on shutdown", async () => {
    const path = await socketPath("matrix-scope-lifecycle-");
    const stalled = await listen(path, (_frame) => undefined);
    const client = createScopeRuntimeClient({
      socketPath: path,
      profileCatalog: catalog,
      timeoutMs: 20,
      createRequestId: () => REQUEST_ID,
    });

    await expect(client.refreshCapability()).resolves.toEqual({
      available: false,
      reason: "supervisor_unavailable",
    });
    await stalled.close();
    cleanup.pop();
    await listen(path, (frame) => capabilityResponse(ScopeRuntimeRequestSchema.parse(frame).requestId));
    await expect(client.refreshCapability()).resolves.toEqual(expect.objectContaining({ available: true }));

    const pending = client.refreshCapability();
    await client.close();
    await expect(pending).resolves.toEqual(expect.objectContaining({ available: false }));
    await expect(client.refreshCapability()).rejects.toBeInstanceOf(ScopeRuntimeClientError);
  });

  it("caps concurrent supervisor requests and drains the bounded set", async () => {
    const path = await socketPath("matrix-scope-capacity-");
    let capabilityServed = false;
    await listen(path, (frame) => {
      const request = ScopeRuntimeRequestSchema.parse(frame);
      if (!capabilityServed && request.type === "capability.get") {
        capabilityServed = true;
        return capabilityResponse(request.requestId);
      }
      return undefined;
    });
    let sequence = 0;
    const client = createScopeRuntimeClient({
      socketPath: path,
      profileCatalog: catalog,
      timeoutMs: 1_000,
      createRequestId: () => `018f0ce5-7b4a-7f95-a7c8-${String(sequence++).padStart(12, "0")}`,
    });
    await client.refreshCapability();

    const pending = Array.from({ length: 64 }, () => client.createRuntime({
      scopeHandle: SCOPE_HANDLE,
      workload: "chat_ai",
      adapterId: "claude-code",
      harnessVersion: "2.1.240",
    }).catch((error: unknown) => error));
    await expect(client.createRuntime({
      scopeHandle: SCOPE_HANDLE,
      workload: "chat_ai",
      adapterId: "claude-code",
      harnessVersion: "2.1.240",
    })).rejects.toMatchObject({ code: "client_capacity" });

    await client.close();
    await expect(Promise.all(pending)).resolves.toEqual(
      expect.arrayContaining([expect.any(ScopeRuntimeClientError)]),
    );
  });
});
