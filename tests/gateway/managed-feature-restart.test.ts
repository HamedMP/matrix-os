import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { createPlatformSpeechHostConfigRoutes } from "../../packages/gateway/src/speech/host-activation.js";
vi.mock("node:child_process", () => ({ execFile: vi.fn((...args: unknown[]) => (args[3] as (error: null) => void)(null)) }));
import { createExecutionAdmissionFence } from "../../packages/gateway/src/execution-admission-fence.js";
import { createManagedFeatureRestartCoordinator } from "../../packages/gateway/src/managed-feature-restart.js";

afterEach(() => { vi.useRealTimers(); });
describe("managed feature restart coordinator", () => {
  it("submits an immediate bounded nonblocking systemctl command after the local delay", async () => {
    vi.useFakeTimers(); const fence = createExecutionAdmissionFence();
    const coordinator = createManagedFeatureRestartCoordinator({ fence, isIdle: () => true });
    coordinator.schedule(); expect(execFile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(execFile).toHaveBeenCalledWith("/usr/bin/sudo", ["-n", "/usr/bin/systemctl", "--no-block", "restart", "matrix-gateway.service"], { timeout: 10_000, maxBuffer: 1024 }, expect.any(Function));
    await coordinator.close();
  });
  it("uses the same idle-safe coordinator for speech host activation", async () => {
    vi.useFakeTimers(); let idle = true;
    const restart = vi.fn().mockResolvedValue(undefined);
    const coordinator = createManagedFeatureRestartCoordinator({ fence: createExecutionAdmissionFence(), isIdle: () => idle, restart });
    const app = createPlatformSpeechHostConfigRoutes({ env: { UPGRADE_TOKEN: "operator-secret", PLATFORM_INTERNAL_URL: "https://app.matrix-os.com", MATRIX_MACHINE_ID: "machine-1", MATRIX_RUNTIME_SLOT: "primary" }, applyConfig: async () => {}, scheduleRestart: coordinator.schedule });
    const post = () => app.request("/config", { method: "POST", headers: { authorization: "Bearer operator-secret", "content-type": "application/json" }, body: JSON.stringify({ machineId: "machine-1", runtimeSlot: "primary", enabled: true, origin: "https://app.matrix-os.com", runtimeToken: "a".repeat(64) }) });
    expect((await post()).status).toBe(202); idle = false;
    await vi.advanceTimersByTimeAsync(2_000); expect(restart).not.toHaveBeenCalled();
    idle = true; expect((await post()).status).toBe(202);
    await vi.advanceTimersByTimeAsync(2_000); expect(restart).toHaveBeenCalledOnce(); await coordinator.close();
  });
  it("releases the fence if submitting the restart throws synchronously", async () => {
    vi.useFakeTimers(); const fence = createExecutionAdmissionFence();
    const restart = vi.fn().mockImplementationOnce(() => { throw new Error("command failed"); }).mockResolvedValue(undefined);
    const coordinator = createManagedFeatureRestartCoordinator({ fence, isIdle: () => true, restart });
    coordinator.schedule(); await vi.advanceTimersByTimeAsync(2_000); expect(fence.blocked).toBe(false);
    coordinator.schedule(); await vi.advanceTimersByTimeAsync(2_000); expect(restart).toHaveBeenCalledTimes(2); await coordinator.close();
  });
  it("defers a newly busy computer at timer expiry, then retries when idle", async () => {
    vi.useFakeTimers();
    const fence = createExecutionAdmissionFence();
    let idle = true;
    const restart = vi.fn().mockResolvedValue(undefined);
    const coordinator = createManagedFeatureRestartCoordinator({ fence, isIdle: () => idle, restart });
    coordinator.schedule();
    idle = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(restart).not.toHaveBeenCalled();
    expect(fence.blocked).toBe(false);
    idle = true;
    coordinator.schedule();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(restart).toHaveBeenCalledOnce();
    expect(fence.blocked).toBe(true);
    await coordinator.close();
    expect(fence.blocked).toBe(true);
  });
  it("coalesces schedules and holds the fence before invoking an immediate restart", async () => {
    vi.useFakeTimers();
    const fence = createExecutionAdmissionFence();
    let finish!: () => void;
    const restart = vi.fn(() => { expect(fence.blocked).toBe(true); return new Promise<void>(resolve => { finish = resolve; }); });
    const coordinator = createManagedFeatureRestartCoordinator({ fence, isIdle: () => true, restart });
    coordinator.schedule(); coordinator.schedule();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000);
    coordinator.schedule();
    expect(restart).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    finish(); await coordinator.close();
  });
  it("releases the fence after command failure and allows another activation retry", async () => {
    vi.useFakeTimers();
    const fence = createExecutionAdmissionFence();
    const restart = vi.fn().mockRejectedValueOnce(new Error("systemctl unavailable")).mockResolvedValue(undefined);
    const coordinator = createManagedFeatureRestartCoordinator({ fence, isIdle: () => true, restart });
    coordinator.schedule(); await vi.advanceTimersByTimeAsync(2_000);
    expect(fence.blocked).toBe(false);
    coordinator.schedule(); await vi.advanceTimersByTimeAsync(2_000);
    expect(restart).toHaveBeenCalledTimes(2);
    expect(fence.blocked).toBe(true);
    await coordinator.close();
  });
  it("clears its timer at shutdown and never restarts afterwards", async () => {
    vi.useFakeTimers(); const fence = createExecutionAdmissionFence(), restart = vi.fn();
    const coordinator = createManagedFeatureRestartCoordinator({ fence, isIdle: () => true, restart });
    coordinator.schedule(); await coordinator.close();
    expect(fence.blocked).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(() => coordinator.schedule()).toThrow("unavailable");
    await vi.advanceTimersByTimeAsync(2_000); expect(restart).not.toHaveBeenCalled();
  });
  it("does not release a fence held by another operation", async () => {
    vi.useFakeTimers(); const fence = createExecutionAdmissionFence(), restart = vi.fn();
    const release = fence.tryAcquire()!;
    const coordinator = createManagedFeatureRestartCoordinator({ fence, isIdle: () => true, restart });
    coordinator.schedule(); await vi.advanceTimersByTimeAsync(2_000);
    expect(restart).not.toHaveBeenCalled(); await coordinator.close(); expect(fence.blocked).toBe(true);
    release(); expect(fence.blocked).toBe(true);
  });
  it("keeps admission fenced when an accepted restart begins gateway shutdown", async () => {
    vi.useFakeTimers(); const fence = createExecutionAdmissionFence();
    const coordinator = createManagedFeatureRestartCoordinator({ fence, isIdle: () => true, restart: async () => {} });
    coordinator.schedule(); await vi.advanceTimersByTimeAsync(2_000);
    expect(fence.blocked).toBe(true); await coordinator.close();
    expect(fence.blocked).toBe(true); expect(fence.tryAcquire()).toBeNull();
  });
  it("holds shutdown admission closed when an in-flight restart command subsequently fails", async () => {
    vi.useFakeTimers(); const fence = createExecutionAdmissionFence();
    let reject!: (error: Error) => void;
    const coordinator = createManagedFeatureRestartCoordinator({ fence, isIdle: () => true, restart: () => new Promise<void>((_resolve, fail) => { reject = fail; }) });
    coordinator.schedule(); await vi.advanceTimersByTimeAsync(2_000);
    const closing = coordinator.close(); expect(fence.blocked).toBe(true);
    reject(new Error("restart command failed during shutdown")); await closing;
    expect(fence.blocked).toBe(true); expect(fence.tryAcquire()).toBeNull();
  });
  it("makes fence releases idempotent across subsequent acquisitions", () => {
    const fence = createExecutionAdmissionFence(); const first = fence.tryAcquire()!;
    expect(fence.tryAcquire()).toBeNull(); first(); const second = fence.tryAcquire()!;
    first(); expect(fence.blocked).toBe(true); second(); expect(fence.blocked).toBe(false);
  });
});
