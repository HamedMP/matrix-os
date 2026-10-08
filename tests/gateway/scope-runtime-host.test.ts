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

function authorizer(handle: string, id = "bots"): ScopeRuntimeAuthorizer & { authorize: ReturnType<typeof vi.fn> } {
  return {
    id,
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

    const shared = authorizer(RUNTIME_A, "shared_ai");
    const bots = authorizer(RUNTIME_B);
    host.registerAuthorizer(shared);
    const unregisterBots = host.registerAuthorizer(bots);
    await expect(probe(paths.broker, RUNTIME_B)).resolves.toMatchObject({ ok: true, status: 200 });
    expect(bots.authorize).toHaveBeenCalledTimes(1);
    expect(shared.authorize).not.toHaveBeenCalled();
    // A handle nobody owns is denied.
    await expect(probe(paths.broker, `runtime_${"c".repeat(32)}`)).resolves.toMatchObject({ ok: false, error: "action_denied" });
    // A handle claimed by two registries is denied rather than guessed.
    const unregisterOther = host.registerAuthorizer(authorizer(RUNTIME_B, "other"));
    await expect(probe(paths.broker, RUNTIME_B)).resolves.toMatchObject({ ok: false, error: "action_denied" });
    unregisterOther();
    // Registering an id again replaces the old registration, and the old one's unregister is then a no-op.
    const replacement = authorizer(RUNTIME_B);
    host.registerAuthorizer(replacement);
    unregisterBots();
    await expect(probe(paths.broker, RUNTIME_B)).resolves.toMatchObject({ ok: true, status: 200 });
    expect(replacement.authorize).toHaveBeenCalledTimes(1);
    expect(bots.authorize).toHaveBeenCalledTimes(1);
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
    for (let index = 0; index < 4; index += 1) host.registerAuthorizer(authorizer(RUNTIME_A, `registry_${index}`));
    expect(() => host.registerAuthorizer(authorizer(RUNTIME_A, "registry_4"))).toThrow(new ScopeRuntimeHostError("capacity_exceeded"));
    // Replacing an existing id needs no new slot.
    expect(() => host.registerAuthorizer(authorizer(RUNTIME_A, "registry_0"))).not.toThrow();
    expect(() => host.registerAuthorizer(authorizer(RUNTIME_A, "Bad-Id"))).toThrow(new ScopeRuntimeHostError("invalid_authorizer"));
    await host.close();
    // Closed in order: the socket is gone and no registration is accepted.
    await expect(stat(upPaths.broker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(() => host.registerAuthorizer(authorizer(RUNTIME_A))).toThrow(new ScopeRuntimeHostError("closed"));
    expect(host.client.capability()).toEqual({ available: false, reason: "supervisor_unavailable" });
  });

  it("routes bot frames to the bot registry and keeps tools off the shared path", async () => {
    const paths = await sockets();
    await fakeSupervisor(paths.supervisor);
    const host = await createScopeRuntimeHost({ homePath: "/tmp", profileCatalog: catalog, supervisorSocket: paths.supervisor, brokerSocket: paths.broker });
    cleanup.push(() => host.close());
    const handled: unknown[] = [];
    host.registerAuthorizer({
      id: "bots",
      owns: (request) => request.runtimeHandle === RUNTIME_B,
      authorize: async () => ({ allowed: false }),
      handleFrame: async (raw) => {
        handled.push(raw);
        return { version: 1, requestId: (raw as { requestId: string }).requestId, ok: true, result: { revision: 3, messages: [] } };
      },
    });
    host.registerAuthorizer(authorizer(RUNTIME_A, "shared_ai"));
    const send = (frame: Record<string, unknown>) => new Promise<string>((resolve, reject) => {
      const socket = createConnection({ path: paths.broker });
      let output = "";
      socket.setEncoding("utf8");
      socket.once("error", reject);
      socket.on("data", (chunk) => { output += chunk; });
      socket.once("close", () => resolve(output));
      socket.once("connect", () => socket.end(`${JSON.stringify(frame)}\n`));
    });
    const envelope = { version: 1, requestId: "018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1", executionGeneration: "3" };

    const load = await send({ ...envelope, runtimeHandle: RUNTIME_B, runId: "run_one", action: "bot.session.load" });
    expect(JSON.parse(load)).toMatchObject({ ok: true, result: { revision: 3 } });
    // A whole-transcript save frame above the old 512 KiB cap still reaches the bot handler.
    const big = await send({ ...envelope, runtimeHandle: RUNTIME_B, runId: "run_one", action: "bot.session.save",
      session: { baseRevision: 3, messages: [{ role: "user", content: "x".repeat(540 * 1024), timestamp: 1 }] } });
    expect(JSON.parse(big)).toMatchObject({ ok: true });
    expect(handled).toHaveLength(2);

    // A shared runtime may not send tools, and bot actions from it never parse.
    const shared = await send({ ...envelope, runtimeHandle: RUNTIME_A, action: "inference.messages", method: "POST",
      path: "/v1/messages?beta=true", headers: {}, body: JSON.stringify({ model: "claude-sonnet-5", stream: true, messages: [{}], tools: [{ name: "x" }] }) });
    expect(JSON.parse(shared)).toMatchObject({ ok: false, error: "invalid_request" });
    await expect(send({ ...envelope, runtimeHandle: RUNTIME_A, runId: "run_one", action: "bot.session.load" })).resolves.toBe("");
    // An unbound runtime's bot frame is dropped.
    await expect(send({ ...envelope, runtimeHandle: `runtime_${"c".repeat(32)}`, runId: "run_one", action: "bot.session.load" })).resolves.toBe("");
    expect(handled).toHaveLength(2);
  });
});
