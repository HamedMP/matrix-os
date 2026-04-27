import { describe, expect, it } from "vitest";
import { shellError, toShellError } from "../../packages/gateway/src/shell/errors.js";

describe("gateway shell error policy", () => {
  it("does not expose raw zellij stderr, stack traces, or filesystem paths", () => {
    const raw = new Error("zellij failed at /home/alice/project\nstack trace");
    expect(toShellError(raw)).toMatchObject({
      code: "shell_failed",
      safeMessage: "Request failed",
    });
  });

  it("preserves stable safe shell errors", () => {
    expect(shellError("invalid_layout", "Invalid layout", 400)).toMatchObject({
      code: "invalid_layout",
      safeMessage: "Invalid layout",
      status: 400,
    });
  });
});
