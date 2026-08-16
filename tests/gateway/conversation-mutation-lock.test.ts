import { describe, expect, it } from "vitest";
import { createConversationMutationLock } from
  "../../packages/gateway/src/conversation-mutation-lock.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("conversation mutation lock", () => {
  it("serializes mutations for the same conversation", async () => {
    const lock = createConversationMutationLock({ maxKeys: 2 });
    const gate = deferred();
    const order: string[] = [];

    const first = lock.run("conversation-a", async () => {
      order.push("first:start");
      await gate.promise;
      order.push("first:end");
    });
    const second = lock.run("conversation-a", async () => {
      order.push("second");
    });

    await Promise.resolve();
    expect(order).toEqual(["first:start"]);

    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
    expect(lock.size).toBe(0);
  });

  it("allows different conversations to mutate concurrently", async () => {
    const lock = createConversationMutationLock({ maxKeys: 2 });
    const gate = deferred();
    const started: string[] = [];

    const first = lock.run("conversation-a", async () => {
      started.push("a");
      await gate.promise;
    });
    const second = lock.run("conversation-b", async () => {
      started.push("b");
      await gate.promise;
    });

    await Promise.resolve();
    expect(started).toEqual(["a", "b"]);

    gate.resolve();
    await Promise.all([first, second]);
    expect(lock.size).toBe(0);
  });

  it("rejects a new key at capacity without blocking an existing key", async () => {
    const lock = createConversationMutationLock({ maxKeys: 1 });
    const gate = deferred();

    const first = lock.run("conversation-a", async () => {
      await gate.promise;
      return "first";
    });
    const sameKey = lock.run("conversation-a", async () => "second");

    await expect(lock.run("conversation-b", async () => "other"))
      .rejects.toThrow("conversation mutation capacity reached");

    gate.resolve();
    await expect(Promise.all([first, sameKey])).resolves.toEqual(["first", "second"]);
  });

  it("cleans up a failed mutation before the next key is admitted", async () => {
    const lock = createConversationMutationLock({ maxKeys: 1 });

    await expect(lock.run("conversation-a", async () => {
      throw new Error("write failed");
    })).rejects.toThrow("write failed");

    expect(lock.size).toBe(0);
    await expect(lock.run("conversation-b", async () => "recovered")).resolves.toBe("recovered");
    expect(lock.size).toBe(0);
  });
});
