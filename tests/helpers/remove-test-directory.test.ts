import { describe, expect, it, vi } from "vitest";
import { removeTestDirectory } from "./remove-test-directory.js";

describe("removeTestDirectory", () => {
  it("passes a bounded retry policy to recursive removal", async () => {
    const remove = vi.fn(async () => undefined);

    await removeTestDirectory("/tmp/matrix-test-home", remove);

    expect(remove).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith("/tmp/matrix-test-home", {
      force: true,
      maxRetries: 5,
      recursive: true,
      retryDelay: 50,
    });
  });

  it("waits for recursive removal to finish", async () => {
    let finishRemoval!: () => void;
    const removal = new Promise<void>((resolve) => {
      finishRemoval = resolve;
    });
    let cleanupFinished = false;

    const cleanup = removeTestDirectory("/tmp/matrix-test-home", () => removal)
      .then(() => {
        cleanupFinished = true;
      });

    await Promise.resolve();
    expect(cleanupFinished).toBe(false);

    finishRemoval();
    await cleanup;
    expect(cleanupFinished).toBe(true);
  });

  it("surfaces persistent removal failures", async () => {
    const failure = new Error("cleanup failed");

    await expect(removeTestDirectory(
      "/tmp/matrix-test-home",
      async () => {
        throw failure;
      },
    )).rejects.toBe(failure);
  });
});
