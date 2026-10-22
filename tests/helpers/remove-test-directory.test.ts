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
});
