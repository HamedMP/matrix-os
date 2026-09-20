import { describe, expect, it } from "vitest";
import { describeScopeRuntimeFailure } from "../../packages/scope-runtime/src/failure.js";

describe("describeScopeRuntimeFailure", () => {
  it("reports the error name for plain errors", () => {
    expect(describeScopeRuntimeFailure(new Error("Invalid reconciled scope runtime unit")))
      .toBe("Error message=Invalid reconciled scope runtime unit");
    expect(describeScopeRuntimeFailure(new TypeError("Bad")))
      .toBe("TypeError message=Bad");
  });

  it("adds bounded errno and Node error codes without the path they mention", () => {
    const enoent = Object.assign(
      new Error("ENOENT: no such file or directory, access '/opt/matrix/runtime/node/bin/node'"),
      { code: "ENOENT" },
    );
    expect(describeScopeRuntimeFailure(enoent)).toBe("Error code=ENOENT");
    const missingModule = Object.assign(
      new Error("Cannot find package 'zod' imported from /opt/matrix/app/packages/scope-runtime/dist/protocol.js"),
      { code: "ERR_MODULE_NOT_FOUND" },
    );
    expect(describeScopeRuntimeFailure(missingModule)).toBe("Error code=ERR_MODULE_NOT_FOUND");
  });

  it("drops messages that could carry host details or unbounded content", () => {
    expect(describeScopeRuntimeFailure(new Error("listen EACCES /run/matrix-scope-runtime/supervisor.sock")))
      .toBe("Error");
    expect(describeScopeRuntimeFailure(new Error("x".repeat(200)))).toBe("Error");
    expect(describeScopeRuntimeFailure(new Error("token=abc\nsecond line"))).toBe("Error");
    expect(describeScopeRuntimeFailure(Object.assign(new Error("Bad"), { code: "not/a code" })))
      .toBe("Error message=Bad");
    expect(describeScopeRuntimeFailure(Object.assign(new Error("Bad"), { code: 42 })))
      .toBe("Error message=Bad");
  });

  it("never throws for non-error values", () => {
    expect(describeScopeRuntimeFailure(undefined)).toBe("UnknownError");
    expect(describeScopeRuntimeFailure("boom")).toBe("UnknownError");
    expect(describeScopeRuntimeFailure({ name: "Fake" })).toBe("UnknownError");
  });
});
