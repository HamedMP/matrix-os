import { afterEach, describe, expect, it, vi } from "vitest";
import { ScopeRuntimeRequestSchema } from "../../packages/scope-runtime/src/protocol.js";
import { FIXED_BOT_SYSTEMD_PROPERTIES } from "../../packages/scope-runtime/src/bot-profile.js";
import { createScopeRuntimeController, SCOPE_RUNTIME_BOT_PROFILE, SCOPE_RUNTIME_MANAGED_PI_PROFILE, SCOPE_RUNTIME_PROFILE, type ScopeRuntimeLauncher } from "../../packages/scope-runtime/src/supervisor.js";

const handle = `runtime_${"2".repeat(32)}`;
const requestId = "018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1";
const scopeHandle = `scope_${"1".repeat(32)}`;
const leaseMs = 900_000;
const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); vi.restoreAllMocks(); vi.useRealTimers(); });

function launcher(overrides: Partial<ScopeRuntimeLauncher> = {}): ScopeRuntimeLauncher {
  return { list: vi.fn(async () => []), start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined),
    supportedAdapters: vi.fn(async (profileId?: string) => profileId === SCOPE_RUNTIME_PROFILE.profileId ? SCOPE_RUNTIME_PROFILE.adapters : SCOPE_RUNTIME_BOT_PROFILE.adapters),
    runChat: vi.fn(async () => ({ text: "ok" })), runBot: vi.fn(async () => ({ version: 1, ok: true, reply: { status: "completed" } })), ...overrides };
}
async function fixture(profileId = SCOPE_RUNTIME_BOT_PROFILE.profileId, native = launcher()) {
  const controller = await createScopeRuntimeController({ launcher: native, executionGeneration: "4", createRuntimeHandle: () => handle });
  closers.push(() => controller.close());
  await expect(controller.handle({ version: 1, type: "runtime.create", requestId, scopeHandle, profileId, workload: "bot_agent", adapterId: "matrix-bot", harnessVersion: "1.0.0",
    sandbox: { version: 1, scopeHandle, actorId: "owner", worktree: { hostPath: "/owned/project", mode: "rw", fingerprint: "a".repeat(64) }, network: "broker_only" } })).resolves.toMatchObject({ ok: true });
  return { controller, native };
}
const renew = (generation = "4") => ({ version: 1, type: "runtime.renew", requestId, runtimeHandle: handle, executionGeneration: generation } as never);
const run = { version: 1, type: "runtime.bot", requestId, runtimeHandle: handle, executionGeneration: "4", command: { version: 1, kind: "bot.run", runId: "run_one" } } as const;

describe("active Pi runtime leases", () => {
  it("binds the no-wall-clock worker to supervisor lifetime while retaining resource isolation", () => {
    expect(FIXED_BOT_SYSTEMD_PROPERTIES).toContain("RuntimeMaxSec=infinity");
    expect(FIXED_BOT_SYSTEMD_PROPERTIES).toContain("BindsTo=matrix-scope-runtime.service");
    expect(FIXED_BOT_SYSTEMD_PROPERTIES).toContain("After=matrix-scope-runtime.service");
    for (const property of ["DynamicUser=yes", "PrivateNetwork=yes", "MemoryMax=1073741824", "CPUQuota=200%", "TasksMax=256", "CapabilityBoundingSet="]) expect(FIXED_BOT_SYSTEMD_PROPERTIES).toContain(property);
  });
  it.each([SCOPE_RUNTIME_BOT_PROFILE.profileId, SCOPE_RUNTIME_MANAGED_PI_PROFILE.profileId])("renews %s past the former 15/16/30 minute cutoffs", async profileId => {
    vi.useFakeTimers();
    const { controller, native } = await fixture(profileId);
    for (let minutes = 0; minutes < 40; minutes += 10) {
      await vi.advanceTimersByTimeAsync(600_000);
      await expect(controller.handle(renew())).resolves.toMatchObject({ ok: true, state: "running", runtimeHandle: handle, executionGeneration: "4" });
    }
    await expect(controller.handle(run)).resolves.toMatchObject({ ok: true });
    expect(native.stop).not.toHaveBeenCalled();
  });
  it("expires a lost gateway lease and cannot resurrect it", async () => {
    vi.useFakeTimers();
    const { controller, native } = await fixture();
    await vi.advanceTimersByTimeAsync(leaseMs - 1);
    expect(native.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(native.stop).toHaveBeenCalledExactlyOnceWith(handle);
    await expect(controller.handle(renew())).resolves.toMatchObject({ ok: false });
    await expect(controller.handle(run)).resolves.toMatchObject({ ok: false, error: "runtime_not_found" });
  });
  it("rejects expiry even if the sweep callback has not run", async () => {
    vi.useFakeTimers();
    const { controller } = await fixture();
    vi.spyOn(performance, "now").mockReturnValue(performance.now() + leaseMs);
    await expect(controller.handle(renew())).resolves.toMatchObject({ ok: false });
    await expect(controller.handle(run)).resolves.toMatchObject({ ok: false });
  });
  it("reclaims a lost gateway after 900 elapsed seconds despite a backward wall-clock adjustment", async () => {
    vi.useFakeTimers();
    const { controller, native } = await fixture();
    vi.setSystemTime(Date.now() - 3_600_000);
    await vi.advanceTimersByTimeAsync(leaseMs);
    expect(native.stop).toHaveBeenCalledExactlyOnceWith(handle);
    await expect(controller.handle(renew())).resolves.toMatchObject({ ok: false });
  });
  it("does not expire a live runtime when the wall clock jumps forward", async () => {
    vi.useFakeTimers();
    const { controller, native } = await fixture();
    vi.setSystemTime(Date.now() + 3_600_000);
    await expect(controller.handle(renew())).resolves.toMatchObject({ ok: true });
    await expect(controller.handle(run)).resolves.toMatchObject({ ok: true });
    expect(native.stop).not.toHaveBeenCalled();
  });
  it("rejects generation mismatch without extending the valid lease", async () => {
    vi.useFakeTimers();
    const { controller, native } = await fixture();
    await vi.advanceTimersByTimeAsync(leaseMs - 30_000);
    await expect(controller.handle(renew("3"))).resolves.toMatchObject({ ok: false });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(native.stop).toHaveBeenCalledExactlyOnceWith(handle);
  });
  it("does not restore an orphaned Pi runtime during supervisor startup", async () => {
    const native = launcher({ list: vi.fn(async () => [{ runtimeHandle: handle, executionGeneration: "3", profileId: SCOPE_RUNTIME_BOT_PROFILE.profileId }]) });
    const controller = await createScopeRuntimeController({ launcher: native, executionGeneration: "4" });
    closers.push(() => controller.close());
    expect(native.stop).toHaveBeenCalledExactlyOnceWith(handle);
    expect(controller.size()).toBe(0);
    await expect(controller.handle(renew("3"))).resolves.toMatchObject({ ok: false });
  });
  it("clears lease timers on Stop and rejects all later renewals", async () => {
    vi.useFakeTimers();
    const { controller, native } = await fixture();
    await expect(controller.handle({ version: 1, type: "runtime.stop", requestId, runtimeHandle: handle })).resolves.toMatchObject({ ok: true, state: "stopped" });
    await expect(controller.handle(renew())).resolves.toMatchObject({ ok: false });
    await vi.advanceTimersByTimeAsync(2 * leaseMs);
    expect(native.stop).toHaveBeenCalledOnce();
    await controller.close();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps a failed Stop revoked and retries orphan cleanup on the bounded sweep", async () => {
    vi.useFakeTimers();
    const native = launcher({ stop: vi.fn().mockRejectedValueOnce(new Error("temporarily unavailable")).mockResolvedValue(undefined) });
    const { controller } = await fixture(undefined, native);
    await expect(controller.handle({ version: 1, type: "runtime.stop", requestId, runtimeHandle: handle })).resolves.toMatchObject({ ok: false });
    await expect(controller.handle(renew())).resolves.toMatchObject({ ok: false });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(native.stop).toHaveBeenCalledTimes(2);
    expect(controller.size()).toBe(0);
  });
  it("never renews the shared-chat profile", async () => {
    const native = launcher({ list: vi.fn(async () => [{ runtimeHandle: handle, executionGeneration: "4" }]) });
    const controller = await createScopeRuntimeController({ launcher: native, executionGeneration: "4" });
    closers.push(() => controller.close());
    await expect(controller.handle(renew())).resolves.toMatchObject({ ok: false });
  });
  it("accepts only identity fields, never client-selected lease duration, root, or capabilities", () => {
    expect(ScopeRuntimeRequestSchema.safeParse(renew()).success).toBe(true);
    for (const field of [{ durationMs: 3600000 }, { root: "/" }, { capabilities: ["write"] }]) expect(ScopeRuntimeRequestSchema.safeParse({ ...renew() as object, ...field }).success).toBe(false);
  });
});
