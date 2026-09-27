import { mkdtemp, rm, stat } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScopeRuntimeCapabilityProfile } from "../../packages/scope-runtime/src/protocol.js";
import { SCOPE_RUNTIME_BOT_PROFILE, SCOPE_RUNTIME_PROFILE } from "../../packages/scope-runtime/src/supervisor.js";
import { SHARED_AI_PROFILE_CATALOG } from "../../packages/gateway/src/collaboration/shared-ai-runtime.js";
import { BOT_SCOPE_RUNTIME_PROFILE_CATALOG } from "../../packages/gateway/src/bots/scope-runtime-profile.js";
import { ScopeRuntimeHostError, createScopeRuntimeHost, type ScopeRuntimeAuthorizer } from "../../packages/gateway/src/scope-runtime-host/index.js";

const RUNTIME_A = `runtime_${"a".repeat(32)}`;
const RUNTIME_B = `runtime_${"b".repeat(32)}`;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.allSettled(cleanup.splice(0).map((remove) => remove())); });

async function sockets() {
  const root = await mkdtemp(join(tmpdir(), "scope-host-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return { supervisor: join(root, "supervisor.sock"), broker: join(root, "broker.sock") };
}

async function fakeSupervisor(path: string, available = true) {
  const profiles = [SCOPE_RUNTIME_PROFILE, SCOPE_RUNTIME_BOT_PROFILE].map((profile) => ({ ...profile, executionGeneration: "3" }) as ScopeRuntimeCapabilityProfile);
  const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { input += chunk; });
    socket.once("end", () => {
      const { requestId } = JSON.parse(input) as { requestId: string };
      socket.end(`${JSON.stringify(available
        ? { version: 1, type: "capability.result", requestId, ok: true, supervisorVersion: "1.0.0", profile: profiles[0], profiles }
        : { version: 1, type: "capability.result", requestId, ok: false, error: "runtime_unavailable" })}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
}

function probe(brokerPath: string, runtimeHandle: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: brokerPath });
    let output = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk) => { output += chunk; });
    socket.once("close", () => resolve(JSON.parse(output.trim() || "{}") as Record<string, unknown>));
    socket.once("connect", () => socket.end(`${JSON.stringify({
      version: 1, action: "inference.messages", requestId: "018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1",
      runtimeHandle, executionGeneration: "3", method: "HEAD", path: "/api/hello", headers: {}, body: "",
    })}\n`));
  });
}

function authorizer(handle: string): ScopeRuntimeAuthorizer & { authorize: ReturnType<typeof vi.fn> } {
  return {
    owns: (request) => request.runtimeHandle === handle,
    authorize: vi.fn(async () => ({ allowed: true as const, allowedModelIds: [], allowedEgressOrigins: [] })),
  };
}

const catalog = { ...SHARED_AI_PROFILE_CATALOG, ...BOT_SCOPE_RUNTIME_PROFILE_CATALOG };

describe("scope runtime host", () => {
  it("serves one broker socket and authorizes each frame through the registry that owns it", async () => {
    const paths = await sockets();
    await fakeSupervisor(paths.supervisor);
    const host = await createScopeRuntimeHost({ homePath: "/tmp", profileCatalog: catalog, supervisorSocket: paths.supervisor, brokerSocket: paths.broker });
    cleanup.push(() => host.close());
    expect(host.available).toBe(true);
    expect(host.client.profileCapability("scope-runtime-bot-v1")).toMatchObject({ available: true });
    expect((await stat(paths.broker)).isSocket()).toBe(true);

    const shared = authorizer(RUNTIME_A);
    const bots = authorizer(RUNTIME_B);
    host.registerAuthorizer(shared);
    const unregisterBots = host.registerAuthorizer(bots);
    await expect(probe(paths.broker, RUNTIME_B)).resolves.toMatchObject({ ok: true, status: 200 });
    expect(bots.authorize).toHaveBeenCalledTimes(1);
    expect(shared.authorize).not.toHaveBeenCalled();
    // A handle nobody owns is denied.
    await expect(probe(paths.broker, `runtime_${"c".repeat(32)}`)).resolves.toMatchObject({ ok: false, error: "action_denied" });
    // A handle claimed by two registries is denied rather than guessed.
    host.registerAuthorizer(authorizer(RUNTIME_B));
    await expect(probe(paths.broker, RUNTIME_B)).resolves.toMatchObject({ ok: false, error: "action_denied" });
    unregisterBots();
  });

  it("stays unavailable without listening when the supervisor is down, and caps registrations", async () => {
    const paths = await sockets();
    await fakeSupervisor(paths.supervisor, false);
    const down = await createScopeRuntimeHost({ homePath: "/tmp", profileCatalog: catalog, supervisorSocket: paths.supervisor, brokerSocket: paths.broker });
    expect(down.available).toBe(false);
    await expect(stat(paths.broker)).rejects.toMatchObject({ code: "ENOENT" });
    await down.close();

    const upPaths = await sockets();
    await fakeSupervisor(upPaths.supervisor);
    const host = await createScopeRuntimeHost({ homePath: "/tmp", profileCatalog: catalog, supervisorSocket: upPaths.supervisor, brokerSocket: upPaths.broker });
    for (let index = 0; index < 4; index += 1) host.registerAuthorizer(authorizer(RUNTIME_A));
    expect(() => host.registerAuthorizer(authorizer(RUNTIME_A))).toThrow(new ScopeRuntimeHostError("capacity_exceeded"));
    await host.close();
    // Closed in order: the socket is gone and no registration is accepted.
    await expect(stat(upPaths.broker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(() => host.registerAuthorizer(authorizer(RUNTIME_A))).toThrow(new ScopeRuntimeHostError("closed"));
    expect(host.client.capability()).toEqual({ available: false, reason: "supervisor_unavailable" });
  });
});
