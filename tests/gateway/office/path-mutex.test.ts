import { describe, expect, it } from "vitest";
import { KeyedMutex, KeyedMutexBusyError } from "../../../packages/gateway/src/office/path-mutex";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("KeyedMutex", () => {
  it("runs operations on one key one at a time, in order", async () => {
    const mutex = new KeyedMutex({ maxKeys: 4, maxWaitersPerKey: 4 });
    const order: string[] = [];
    const gate = deferred();
    const first = mutex.run("a", async () => { order.push("first:start"); await gate.promise; order.push("first:end"); });
    const second = mutex.run("a", async () => { order.push("second"); });
    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("runs different keys in parallel", async () => {
    const mutex = new KeyedMutex({ maxKeys: 4, maxWaitersPerKey: 4 });
    const gate = deferred();
    const slow = mutex.run("a", () => gate.promise);
    let otherRan = false;
    await mutex.run("b", async () => { otherRan = true; });
    expect(otherRan).toBe(true);
    gate.resolve();
    await slow;
  });

  it("releases the key when an operation fails", async () => {
    const mutex = new KeyedMutex({ maxKeys: 4, maxWaitersPerKey: 4 });
    await expect(mutex.run("a", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(mutex.run("a", async () => 7)).resolves.toBe(7);
    expect(mutex.size).toBe(0);
  });

  it("evicts idle keys and refuses new keys while the registry is full of active ones", async () => {
    const mutex = new KeyedMutex({ maxKeys: 2, maxWaitersPerKey: 4 });
    await mutex.run("a", async () => undefined);
    await mutex.run("b", async () => undefined);
    expect(mutex.size).toBe(0);
    const gate = deferred();
    const a = mutex.run("a", () => gate.promise);
    const b = mutex.run("b", () => gate.promise);
    await expect(mutex.run("c", async () => undefined)).rejects.toBeInstanceOf(KeyedMutexBusyError);
    gate.resolve();
    await Promise.all([a, b]);
    await expect(mutex.run("c", async () => "ok")).resolves.toBe("ok");
  });

  it("caps the waiters on one key", async () => {
    const mutex = new KeyedMutex({ maxKeys: 2, maxWaitersPerKey: 1 });
    const gate = deferred();
    const holder = mutex.run("a", () => gate.promise);
    const waiter = mutex.run("a", async () => "waited");
    await expect(mutex.run("a", async () => undefined)).rejects.toBeInstanceOf(KeyedMutexBusyError);
    gate.resolve();
    await holder;
    await expect(waiter).resolves.toBe("waited");
  });

  // Fault detected: a caller that already gave up keeps its place and later runs (and saves) after its deadline.
  it("drops a waiter whose deadline passes in the queue without running it, and keeps the order behind it", async () => {
    const mutex = new KeyedMutex({ maxKeys: 2, maxWaitersPerKey: 4 });
    const order: string[] = [];
    const gate = deferred();
    const holder = mutex.run("a", async () => { order.push("holder"); await gate.promise; });
    const expired = mutex.run("a", async () => { order.push("expired"); }, { deadline: { remainingMs: () => 20 } });
    const later = mutex.run("a", async () => { order.push("later"); });
    await expect(expired).rejects.toBeInstanceOf(KeyedMutexBusyError);
    expect(order).toEqual(["holder"]);
    gate.resolve();
    await Promise.all([holder, later]);
    expect(order).toEqual(["holder", "later"]);
    expect(mutex.size).toBe(0);
  });

  it("does not start an operation whose deadline has already passed", async () => {
    const mutex = new KeyedMutex({ maxKeys: 2, maxWaitersPerKey: 4 });
    let ran = false;
    await expect(mutex.run("a", async () => { ran = true; }, { deadline: { remainingMs: () => 0 } })).rejects.toBeInstanceOf(KeyedMutexBusyError);
    expect(ran).toBe(false);
    expect(mutex.size).toBe(0);
  });
});
