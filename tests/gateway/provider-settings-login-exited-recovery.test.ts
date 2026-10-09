import { createNativeProviderProfileGuard } from "../../packages/gateway/src/ai-providers/native-provider-profile-guard.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProviderTerminalLoginCoordinator } from "../../packages/gateway/src/ai-providers/provider-terminal-login-coordinator.js";

const writes = vi.hoisted(() => ({ count: 0, failAt: 0 }));
vi.mock("../../packages/gateway/src/ai-providers/provider-settings-persistence.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../packages/gateway/src/ai-providers/provider-settings-persistence.js")>();
  return { ...actual, writeProviderJsonAtomic: vi.fn(async (...args: Parameters<typeof actual.writeProviderJsonAtomic>) => {
    if (++writes.count === writes.failAt) throw new Error("storage unavailable");
    return actual.writeProviderJsonAtomic(...args);
  }) };
});

describe("provider login exited-terminal recovery", () => {
  let homePath: string;
  let clock: Date;
  const terminals = new Set<string>();
  let liveness: "running" | "stopped" | "unknown";
  const registry = {
    get: vi.fn(async (name: string) => {
      if (!terminals.has(name)) throw Object.assign(new Error("missing"), { code: "session_not_found" });
      return { name };
    }),
    create: vi.fn(async ({ name }: { name: string }) => { terminals.add(name); liveness = "running"; return { name }; }),
    delete: vi.fn(async (name: string) => { terminals.delete(name); }),
    rename: vi.fn(async (name: string, nextName: string) => {
      if (!terminals.delete(name)) throw Object.assign(new Error("missing"), { code: "session_not_found" });
      terminals.add(nextName); return { name: nextName };
    }),
    observeAgentLiveness: vi.fn(async () => liveness),
    archiveStopped: vi.fn(async (name: string, nextName: string, _agent: string) => {
      if (_agent !== "claude" || liveness !== "stopped") throw new Error("identity changed");
      if (!terminals.delete(name)) throw new Error("missing");
      terminals.add(nextName); return { name: nextName };
    }),
  };
  const input = {
    mutation: { type: "start_login" as const, expectedRevision: 0, idempotencyKey: "first", harnessInstanceId: "harness_claude_code", accountId: null, method: "terminal" as const },
    harness: { id: "harness_claude_code", driverId: "claude_code", harness: "claude" as const, providerId: "anthropic", modelId: "claude-sonnet-5", installState: "installed" as const },
  };
  beforeEach(async () => {
    homePath = await mkdtemp(join(tmpdir(), "provider-login-exited-"));
    clock = new Date("2026-10-01T00:00:00Z");
    terminals.clear(); liveness = "running";
    vi.clearAllMocks();
    writes.count = 0; writes.failAt = 0;
  });
  afterEach(async () => { await rm(homePath, { recursive: true, force: true }); });
  function login() { return createProviderTerminalLoginCoordinator({ homePath, registry, profileGuard: createNativeProviderProfileGuard({ homePath, registry }), enabledHarnesses: ["claude"], now: () => clock }); }
  const retry = { ...input, mutation: { ...input.mutation, expectedRevision: 1, idempotencyKey: "retry" } };

  it.each([false, true])("preserves ended login output and starts a fresh login when expired=%s", async expired => {
    const service = login();
    const first = await service.startLogin(input);
    if (first.action.kind !== "open_terminal") throw new Error("Expected terminal");
    if (expired) clock = new Date(Date.parse(first.expiresAt) + 1);
    liveness = "stopped";
    const second = await service.startLogin(retry);
    expect(second.state).toBe("pending");
    expect(registry.archiveStopped).toHaveBeenCalledWith(first.action.terminalSessionId, expect.stringMatching(/^provider-auth-ended-[a-f0-9]{40}$/), "claude");
    expect(registry.create).toHaveBeenCalledTimes(2);
    expect(registry.delete).not.toHaveBeenCalled();
    expect(terminals.size).toBe(2);
    await service.startLogin({ ...retry, mutation: { ...retry.mutation, idempotencyKey: "third", expectedRevision: 2 } });
    expect(registry.create).toHaveBeenCalledTimes(2);
    expect(registry.archiveStopped).toHaveBeenCalledOnce();
  });

  it.each([false, true])("does not duplicate an active login when expired=%s", async expired => {
    const service = login(); const first = await service.startLogin(input);
    if (expired) clock = new Date(Date.parse(first.expiresAt) + 1);
    const second = await service.startLogin(retry);
    expect(second.action).toEqual(first.action);
    expect(registry.create).toHaveBeenCalledOnce();
    expect(registry.archiveStopped).not.toHaveBeenCalled();
    expect(registry.delete).not.toHaveBeenCalled();
  });

  it.each([false, true])("fails safely without changing terminals when observation is unknown and expired=%s", async expired => {
    const service = login(); const first = await service.startLogin(input);
    if (expired) clock = new Date(Date.parse(first.expiresAt) + 1);
    liveness = "unknown";
    await expect(service.startLogin(retry)).rejects.toMatchObject({ code: "lifecycle_unavailable" });
    expect(registry.create).toHaveBeenCalledOnce();
    expect(registry.archiveStopped).not.toHaveBeenCalled();
    expect(registry.delete).not.toHaveBeenCalled();
  });

  it("retains ended output and fences an ambiguous replacement-create failure", async () => {
    const service = login(); await service.startLogin(input); liveness = "stopped";
    registry.create.mockRejectedValueOnce(new Error("unavailable"));
    await expect(service.startLogin(retry)).rejects.toThrow();
    expect(terminals.size).toBe(1);
    expect([...terminals][0]).toMatch(/^provider-auth-ended-/);
    // A lost create reply may precede native session visibility. Neither the
    // ended historical pane nor an absent replacement proves no writer ran.
    await expect(service.startLogin(retry)).rejects.toMatchObject({ code: "lifecycle_unavailable" });
    await expect(login().startLogin(retry)).rejects.toMatchObject({ code: "lifecycle_unavailable" });
    expect(terminals.size).toBe(1); expect(registry.create).toHaveBeenCalledTimes(2);
    expect(registry.archiveStopped).toHaveBeenCalledOnce();
    expect(registry.delete).not.toHaveBeenCalled();
  });

  it.each([false, true])("gives replacement a full lifetime when observation crosses expiry=%s", async crossesExpiry => {
    const service = login(); const first = await service.startLogin(input);
    clock = new Date(Date.parse(first.expiresAt) - 1);
    liveness = "stopped";
    // Both admission observations occur before the serialized recovery read.
    // Cross expiry at the actual recovery observation, not either preflight.
    if (crossesExpiry) registry.observeAgentLiveness.mockResolvedValueOnce("stopped").mockResolvedValueOnce("stopped").mockImplementationOnce(async () => {
      clock = new Date(clock.getTime() + 2); return "stopped";
    });
    const second = await service.startLogin(retry);
    expect(second.id).not.toBe(first.id);
    expect(Date.parse(second.expiresAt) - clock.getTime()).toBe(600_000);
    expect(registry.create).toHaveBeenCalledTimes(2);
    // Old keys remain immutable, while new keys recover the sole replacement.
    const replay = await service.startLogin(input);
    expect(replay.id).toBe(first.id);
    await service.startLogin({ ...retry, mutation: { ...retry.mutation, idempotencyKey: "third", expectedRevision: 2 } });
    expect(registry.create).toHaveBeenCalledTimes(2);
  });

  it.each([1, 2, 3, 4])("recovers after replacement persistence boundary %s fails with proven drain", async boundary => {
    const service = login(); const first = await service.startLogin(input); liveness = "stopped";
    // At boundary4 the replacement was launched. Closing its tab alone does
    // not prove drain; this positive fixture separately observes child exit.
    if (boundary === 4) registry.delete.mockImplementationOnce(async name => {
      terminals.delete(name); liveness = "stopped";
    });
    writes.failAt = writes.count + boundary;
    await expect(service.startLogin(retry)).rejects.toThrow();
    {
      const createsBeforeReplay = registry.create.mock.calls.length;
      expect((await service.startLogin(input)).id).toBe(first.id);
      expect(registry.create).toHaveBeenCalledTimes(createsBeforeReplay);
    }
    const recovered = await service.startLogin({ ...retry, mutation: { ...retry.mutation, idempotencyKey: "retry_after_partial_write" } });
    expect(recovered.state).toBe("pending");
    expect(recovered.id).not.toBe(first.id);
    expect(Date.parse(recovered.expiresAt) - clock.getTime()).toBe(600_000);
    expect(terminals.size).toBe(2);
    expect([...terminals].filter(name => name.startsWith("provider-auth-ended-"))).toHaveLength(1);
    const creates = registry.create.mock.calls.length;
    await service.startLogin({ ...retry, mutation: { ...retry.mutation, idempotencyKey: "third", expectedRevision: 2 } });
    expect(registry.create).toHaveBeenCalledTimes(creates);
  });

  it.each(["running", "unknown", "missing"] as const)("retains replacement admission after receipt failure and tab deletion when child state is %s", async state => {
    const service = login(); await service.startLogin(input); liveness = "stopped";
    registry.delete.mockImplementationOnce(async name => {
      terminals.delete(name);
      if (state === "missing") registry.observeAgentLiveness.mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "session_not_found" }));
      else liveness = state;
    });
    writes.failAt = writes.count + 4;
    await expect(service.startLogin(retry)).rejects.toMatchObject({ code: "lifecycle_unavailable" });
    expect(registry.delete).toHaveBeenCalledOnce(); expect(registry.create).toHaveBeenCalledTimes(2);
    expect([...terminals]).toEqual([expect.stringMatching(/^provider-auth-ended-/)]);
    await expect(service.startLogin({ ...retry, mutation: { ...retry.mutation, idempotencyKey: "no_early_retry" } })).rejects.toMatchObject({ code: "lifecycle_unavailable" });
    await expect(login().startLogin(retry)).rejects.toMatchObject({ code: "lifecycle_unavailable" });
    expect(registry.create).toHaveBeenCalledTimes(2);
  });

  it("does not resolve an old attempt to a replacement when its original terminal disappeared", async () => {
    const service = login(); const first = await service.startLogin(input);
    if (first.action.kind !== "open_terminal") throw new Error("Expected terminal");
    terminals.delete(first.action.terminalSessionId);
    await service.startLogin(retry);
    await expect(service.resolveTerminalIdentity(first)).rejects.toMatchObject({ code: "lifecycle_unavailable" });
    await expect(service.resolveTerminalIdentity({ ...first, id: "attempt_unrecorded" }))
      .rejects.toMatchObject({ code: "lifecycle_unavailable" });
  });
});
