import { describe, expect, it, vi } from "vitest";
import { createLocalChatImportWorker } from "../../packages/gateway/src/chat/local-import/worker.js";
describe("local Chat import worker lifecycle", () => {
  it("bounds work to one verification and drains cancellation before closing dependencies", async () => {
    let finish!: () => void; let entered!: () => void; const started = new Promise<void>(r => { entered = r; });
    const step = vi.fn(async (signal: AbortSignal) => { entered(); await new Promise<void>(resolve => { finish = resolve; signal.addEventListener("abort", resolve, { once: true }); }); return false; });
    const worker = createLocalChatImportWorker({ step, sweep: vi.fn(async () => {}) }); worker.wake(); await started; worker.wake(); worker.wake();
    expect(step).toHaveBeenCalledTimes(1); await worker.close(); finish(); expect(step).toHaveBeenCalledTimes(1);
    worker.wake(); expect(step).toHaveBeenCalledTimes(1);
  });
});
