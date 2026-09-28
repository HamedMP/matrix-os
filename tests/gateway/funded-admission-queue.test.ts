import { describe, expect, it, vi } from "vitest";
import {
  createFundedAdmissionQueue,
  FundedAdmissionClosedError,
  FundedAdmissionFullError,
  FundedAdmissionTimeoutError,
  type FundedAttemptResult,
} from "../../packages/gateway/src/funded-ai/admission-queue.js";

function harness() {
  let now = 0;
  const sleeps: Array<{ ms: number; resolve: () => void }> = [];
  const queue = createFundedAdmissionQueue({
    now: () => now,
    sleep: (ms, signal) => new Promise<void>((resolve, reject) => {
      const entry = { ms, resolve };
      sleeps.push(entry);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  });
  const flush = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };
  const wakeNext = async (advanceMs = 0) => {
    await flush();
    now += advanceMs;
    sleeps.shift()?.resolve();
    await flush();
  };
  return { queue, sleeps, wakeNext, flush, advance: (ms: number) => { now += ms; } };
}

/** Busy until `slot.open`, then records who got through. */
function slotAttempt(slot: { open: boolean; served: string[] }, name: string) {
  return vi.fn(async (): Promise<FundedAttemptResult<string>> => {
    if (!slot.open) return { kind: "busy" };
    slot.served.push(name);
    return { kind: "done", value: name };
  });
}

describe("funded admission queue", () => {
  it("passes a first attempt straight through when nobody is waiting", async () => {
    const { queue } = harness();
    await expect(queue.run({ requestClass: "background" }, async () => ({ kind: "done", value: 1 }))).resolves.toBe(1);
  });

  it("retries waiters interactive first, then FIFO, with bounded backoff", async () => {
    const { queue, sleeps, wakeNext } = harness();
    const slot = { open: false, served: [] as string[] };
    const background = queue.run({ requestClass: "background" }, slotAttempt(slot, "background"));
    const firstTurn = queue.run({ requestClass: "interactive" }, slotAttempt(slot, "turn_1"));
    const secondTurn = queue.run({ requestClass: "interactive" }, slotAttempt(slot, "turn_2"));
    await wakeNext();
    expect(sleeps[0]?.ms ?? 0).toBeGreaterThanOrEqual(250);

    slot.open = true;
    await wakeNext();
    await wakeNext();
    await wakeNext();

    await expect(Promise.all([firstTurn, secondTurn, background])).resolves.toEqual(["turn_1", "turn_2", "background"]);
    expect(slot.served).toEqual(["turn_1", "turn_2", "background"]);
  });

  it("does not let a new background request jump ahead of waiting interactive turns", async () => {
    const { queue, wakeNext } = harness();
    const slot = { open: false, served: [] as string[] };
    const turn = queue.run({ requestClass: "interactive" }, slotAttempt(slot, "turn"));
    await wakeNext();
    slot.open = true;
    const lateBackground = slotAttempt(slot, "late_background");
    const background = queue.run({ requestClass: "background" }, lateBackground);
    await wakeNext();
    await wakeNext();
    await expect(Promise.all([turn, background])).resolves.toEqual(["turn", "late_background"]);
    expect(slot.served).toEqual(["turn", "late_background"]);
  });

  it("doubles backoff up to two seconds while the slot stays busy", async () => {
    const { queue, sleeps, wakeNext } = harness();
    const slot = { open: false, served: [] as string[] };
    void queue.run({ requestClass: "interactive" }, slotAttempt(slot, "turn")).catch(() => undefined);
    const observed: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      await wakeNext();
      if (sleeps[0]) observed.push(sleeps[0].ms);
    }
    expect(observed.slice(0, 5)).toEqual([500, 1_000, 2_000, 2_000, 2_000]);
    queue.close();
  });

  it("ends interactive waits after two minutes and background waits after ten", async () => {
    const { queue, wakeNext } = harness();
    const slot = { open: false, served: [] as string[] };
    const turn = queue.run({ requestClass: "interactive" }, slotAttempt(slot, "turn"));
    const background = queue.run({ requestClass: "background" }, slotAttempt(slot, "background"));
    await wakeNext(120_001);
    await wakeNext();
    await expect(turn).rejects.toBeInstanceOf(FundedAdmissionTimeoutError);
    await wakeNext(480_000);
    await wakeNext();
    await expect(background).rejects.toBeInstanceOf(FundedAdmissionTimeoutError);
  });

  it("caps waiters at 64 and removes cancelled waiters", async () => {
    const { queue } = harness();
    const busy = async (): Promise<FundedAttemptResult<string>> => ({ kind: "busy" });
    const waiting = Array.from({ length: 64 }, () => queue.run({ requestClass: "background" }, busy).catch((error: unknown) => error));
    await expect(queue.run({ requestClass: "interactive" }, busy)).rejects.toBeInstanceOf(FundedAdmissionFullError);

    const controller = new AbortController();
    queue.close();
    const results = await Promise.all(waiting);
    expect(results.every((result) => result instanceof FundedAdmissionClosedError)).toBe(true);
    await expect(queue.run({ requestClass: "interactive", signal: controller.signal }, busy)).rejects.toBeInstanceOf(FundedAdmissionClosedError);
  });

  it("rejects a cancelled waiter without attempting it again", async () => {
    const { queue, wakeNext } = harness();
    const attempt = vi.fn(async (): Promise<FundedAttemptResult<string>> => ({ kind: "busy" }));
    const controller = new AbortController();
    const pending = queue.run({ requestClass: "interactive", signal: controller.signal }, attempt);
    await wakeNext();
    controller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow("cancelled");
    const calls = attempt.mock.calls.length;
    await wakeNext();
    expect(attempt).toHaveBeenCalledTimes(calls);
    queue.close();
  });

  it("propagates attempt failures to that waiter only", async () => {
    const { queue, wakeNext } = harness();
    const slot = { open: false, served: [] as string[] };
    let failNext = false;
    const failing = queue.run({ requestClass: "interactive" }, async (): Promise<FundedAttemptResult<string>> => {
      if (failNext) throw new Error("upstream failed");
      return { kind: "busy" };
    });
    const other = queue.run({ requestClass: "interactive" }, slotAttempt(slot, "other"));
    await wakeNext();
    failNext = true;
    slot.open = true;
    await wakeNext();
    await expect(failing).rejects.toThrow("upstream failed");
    await wakeNext();
    await expect(other).resolves.toBe("other");
  });
});
