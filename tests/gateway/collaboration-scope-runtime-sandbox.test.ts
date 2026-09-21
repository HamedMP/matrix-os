/**
 * S07 / T036 (gateway side): the scope runtime client forwards the sandbox
 * manifest, refuses sandboxed launches against a supervisor without the
 * policy, and surfaces the sandbox capability for readiness.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createScopeRuntimeClient } from "../../packages/gateway/src/collaboration/scope-runtime-client.js";
import { createSandboxReadinessProbe } from "../../packages/gateway/src/collaboration/sandbox-readiness.js";
import {
  SCOPE_RUNTIME_PROFILE_DIGEST,
  SCOPE_RUNTIME_PROFILE_ID,
  SCOPE_RUNTIME_PROFILE_VERSION,
  SCOPE_RUNTIME_HARNESS_VERSION,
} from "../../packages/scope-runtime/src/profile.js";
import {
  SCOPE_RUNTIME_SANDBOX_POLICY_DIGEST,
  SCOPE_RUNTIME_SANDBOX_POLICY_VERSION,
} from "../../packages/scope-runtime/src/sandbox.js";

const SCOPE_HANDLE = "scope_11111111111111111111111111111111";
const RUNTIME_HANDLE = "runtime_22222222222222222222222222222222";
const servers: Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function supervisor(options: { sandbox: boolean; capture: unknown[] }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "s07-client-"));
  dirs.push(dir);
  const socketPath = join(dir, "supervisor.sock");
  const profile = {
    profileId: SCOPE_RUNTIME_PROFILE_ID,
    profileVersion: SCOPE_RUNTIME_PROFILE_VERSION,
    profileDigest: SCOPE_RUNTIME_PROFILE_DIGEST,
    executionGeneration: "9",
    identity: { mode: "dynamic", uidMin: 61_184, uidMax: 65_519 },
    limits: { memoryMaxBytes: 1_073_741_824, cpuQuotaPercent: 200, tasksMax: 256, storageMaxBytes: 10_737_418_240 },
    adapters: [{ adapterId: "claude-code", harnessVersion: SCOPE_RUNTIME_HARNESS_VERSION, workloads: ["chat_ai"] }],
    ...(options.sandbox ? { sandbox: {
      policyVersion: SCOPE_RUNTIME_SANDBOX_POLICY_VERSION,
      policyDigest: SCOPE_RUNTIME_SANDBOX_POLICY_DIGEST,
      workloads: ["chat_ai"],
    } } : {}),
  };
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { buffer += chunk; });
    socket.on("end", () => {
      const request = JSON.parse(buffer.trim()) as { type: string; requestId: string };
      options.capture.push(request);
      const response = request.type === "capability.get"
        ? { version: 1, type: "capability.result", requestId: request.requestId, ok: true, supervisorVersion: "1.0.0", profile }
        : { version: 1, type: "runtime.result", requestId: request.requestId, ok: true, runtimeHandle: RUNTIME_HANDLE, executionGeneration: "9", state: "running" };
      socket.end(`${JSON.stringify(response)}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  servers.push(server);
  return socketPath;
}

const catalog = (sandbox: boolean) => ({
  [SCOPE_RUNTIME_PROFILE_ID]: {
    profileVersion: SCOPE_RUNTIME_PROFILE_VERSION,
    profileDigest: SCOPE_RUNTIME_PROFILE_DIGEST,
    identity: { mode: "dynamic" as const, uidMin: 61_184, uidMax: 65_519 },
    supportedAdapters: { "claude-code": { harnessVersions: [SCOPE_RUNTIME_HARNESS_VERSION], workloads: ["chat_ai" as const] } },
    ...(sandbox ? { sandbox: { policyVersion: SCOPE_RUNTIME_SANDBOX_POLICY_VERSION, policyDigest: SCOPE_RUNTIME_SANDBOX_POLICY_DIGEST } } : {}),
  },
});

const manifest = {
  version: 1 as const,
  scopeHandle: SCOPE_HANDLE,
  actorId: "user_member",
  worktree: { hostPath: "/home/matrix/home/projects/launch-site", mode: "rw" as const, fingerprint: "a".repeat(64) },
  network: "none" as const,
};

describe("scope runtime client sandbox", () => {
  it("forwards the manifest on runtime.create when the supervisor advertises the policy", async () => {
    const capture: unknown[] = [];
    const client = createScopeRuntimeClient({ socketPath: await supervisor({ sandbox: true, capture }), profileCatalog: catalog(true) });
    const capability = await client.refreshCapability();
    expect(capability).toMatchObject({ available: true, sandbox: { policyDigest: SCOPE_RUNTIME_SANDBOX_POLICY_DIGEST, workloads: ["chat_ai"] } });
    await expect(client.createRuntime({ scopeHandle: SCOPE_HANDLE, workload: "chat_ai", adapterId: "claude-code", harnessVersion: SCOPE_RUNTIME_HARNESS_VERSION, sandbox: manifest }))
      .resolves.toMatchObject({ runtimeHandle: RUNTIME_HANDLE });
    expect(capture.at(-1)).toMatchObject({ type: "runtime.create", sandbox: { actorId: "user_member", network: "none" } });
    await expect(client.createRuntime({ scopeHandle: SCOPE_HANDLE, workload: "chat_ai", adapterId: "claude-code", harnessVersion: SCOPE_RUNTIME_HARNESS_VERSION }))
      .rejects.toMatchObject({ code: "runtime_unavailable" });
    expect(capture.filter((entry) => (entry as { type: string }).type === "runtime.create")).toHaveLength(1);
    await client.close();
  });

  it("refuses a sandboxed launch and reports an unsupported profile when the supervisor lacks the policy", async () => {
    const capture: unknown[] = [];
    const client = createScopeRuntimeClient({ socketPath: await supervisor({ sandbox: false, capture }), profileCatalog: catalog(true) });
    await expect(client.refreshCapability()).resolves.toEqual({ available: false, reason: "unsupported_profile" });
    await expect(client.createRuntime({ scopeHandle: SCOPE_HANDLE, workload: "chat_ai", adapterId: "claude-code", harnessVersion: SCOPE_RUNTIME_HARNESS_VERSION, sandbox: manifest }))
      .rejects.toMatchObject({ code: "runtime_unavailable" });
    expect(capture.filter((entry) => (entry as { type: string }).type === "runtime.create")).toHaveLength(0);
    await client.close();
  });

  it("rejects a digest mismatch as unsupported rather than launching wider", async () => {
    const capture: unknown[] = [];
    const client = createScopeRuntimeClient({ socketPath: await supervisor({ sandbox: true, capture }), profileCatalog: {
      ...catalog(true),
      [SCOPE_RUNTIME_PROFILE_ID]: { ...catalog(true)[SCOPE_RUNTIME_PROFILE_ID], sandbox: { policyVersion: 1, policyDigest: "b".repeat(64) } },
    } });
    await expect(client.refreshCapability()).resolves.toEqual({ available: false, reason: "unsupported_profile" });
    await client.close();
  });
});

describe("sandbox readiness probe", () => {
  it("reports shared runs as unsupported until the sandbox policy is available, and terminals as observable", async () => {
    const capture: unknown[] = [];
    const unavailable = createScopeRuntimeClient({ socketPath: await supervisor({ sandbox: false, capture }), profileCatalog: catalog(true) });
    await unavailable.refreshCapability();
    const probe = createSandboxReadinessProbe({ client: unavailable });
    const subject = { ownerId: "user_owner", scopeId: "8a2a8c4e-8a2a-4c4e-8a2a-8c4e8a2a8c4e", organizationId: "org_matrix" };
    await expect(probe.supported({ ...subject, resourceKind: "project" })).resolves.toBe(false);
    await expect(probe.supported({ ...subject, resourceKind: "chat" })).resolves.toBe(false);
    await expect(probe.supported({ ...subject, resourceKind: "terminal" })).resolves.toBe(true);
    await expect(probe.supported({ ...subject, resourceKind: "file" })).resolves.toBe(true);
    await unavailable.close();
    const available = createScopeRuntimeClient({ socketPath: await supervisor({ sandbox: true, capture }), profileCatalog: catalog(true) });
    await available.refreshCapability();
    const ready = createSandboxReadinessProbe({ client: available });
    await expect(ready.supported({ ...subject, resourceKind: "project" })).resolves.toBe(true);
    await expect(ready.sandboxTerminalSupported()).resolves.toBe(false);
    await available.close();
  });
});
