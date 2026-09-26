import { afterEach, describe, expect, it, vi } from "vitest";
import { createProviderRuntimeRecoveryReader } from "../../packages/gateway/src/ai-providers/provider-runtime-recovery-reader.js";
import type { ProviderSettingsRuntimeCoordinator } from "../../packages/gateway/src/ai-providers/provider-settings-coordinators.js";

afterEach(() => vi.useRealTimers());
function fixture() {
  let ready = false;
  const reconcilePending = vi.fn(async () => undefined);
  const coordinator: ProviderSettingsRuntimeCoordinator = {
    supportedActions: [], isRecoveryReady: () => ready, reconcilePending,
    applyConfiguration: async () => undefined, rollbackConfiguration: async () => undefined,
  };
  return { coordinator, reconcilePending, setReady: () => { ready = true; } };
}
describe("bounded explicit runtime recovery reads", () => {
  it("never retries an ordinary read and requires readiness after successful reconciliation", async () => {
    const f = fixture();
    const read = createProviderRuntimeRecoveryReader(f.coordinator);
    await expect(read(false)).rejects.toMatchObject({ code: "runtime_unavailable" });
    expect(f.reconcilePending).not.toHaveBeenCalled();
    await expect(read(true)).rejects.toMatchObject({ code: "runtime_unavailable" });
    expect(f.reconcilePending).toHaveBeenCalledTimes(1);
  });
  it("bounds each response and shares one unfinished compensation instead of starting duplicate retries", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let finish!: () => void;
    f.reconcilePending.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const read = createProviderRuntimeRecoveryReader(f.coordinator, 25);
    const first = expect(read(true)).rejects.toMatchObject({ code: "runtime_unavailable", status: 503 });
    await vi.advanceTimersByTimeAsync(25);
    await first;
    const second = expect(read(true)).rejects.toMatchObject({ code: "runtime_unavailable", status: 503 });
    await vi.advanceTimersByTimeAsync(25);
    await second;
    expect(f.reconcilePending).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    f.setReady(); finish();
    await Promise.resolve();
    await expect(read(false)).resolves.toBeUndefined();
    expect(f.reconcilePending).toHaveBeenCalledTimes(1);
  });
  it("allows a later explicit retry after failure without exposing private error text", async () => {
    const f = fixture();
    f.reconcilePending.mockRejectedValueOnce(new Error("private credential/path details"));
    f.reconcilePending.mockImplementationOnce(async () => f.setReady());
    const read = createProviderRuntimeRecoveryReader(f.coordinator);
    await expect(read(true)).rejects.toMatchObject({ message: "runtime_unavailable", status: 503 });
    await expect(read(true)).resolves.toBeUndefined();
    expect(f.reconcilePending).toHaveBeenCalledTimes(2);
  });
});
