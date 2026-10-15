import { describe, expect, it } from "vitest";
import { CODEX_VERIFIED_VERSION } from "../../packages/contracts/src/index.js";
import { SCOPE_RUNTIME_CODEX_VERSION, SCOPE_RUNTIME_PROFILE_DIGEST } from "../../packages/scope-runtime/src/profile.js";
import { SCOPE_RUNTIME_CODEX_HARNESS_VERSION } from "../../packages/scope-runtime/src/worker-common.js";
import { parseScopeRuntimeWorkerArguments } from "../../packages/scope-runtime/src/worker.js";
import { SCOPE_RUNTIME_PROFILE } from "../../packages/scope-runtime/src/supervisor.js";

const invocation = ["runtime_22222222222222222222222222222222", "scope_11111111111111111111111111111111", "chat_ai", "codex"];

describe("scope Codex qualification agrees with the owner CLI contract", () => {
  it("keeps the standalone worker/profile pin aligned without loading contracts into the worker bundle", () => {
    expect(SCOPE_RUNTIME_CODEX_HARNESS_VERSION).toBe(CODEX_VERIFIED_VERSION);
    expect(SCOPE_RUNTIME_CODEX_VERSION).toBe(CODEX_VERIFIED_VERSION);
    expect(SCOPE_RUNTIME_PROFILE.adapters.find(adapter => adapter.adapterId === "codex")?.harnessVersion).toBe(CODEX_VERIFIED_VERSION);
    expect(SCOPE_RUNTIME_PROFILE_DIGEST).not.toBe("9f4e3e2ad9e63cb300854dfca7bc31370d4cbae6d15fab902841b2b50a6443c0");
  });
  it("admits the qualified executable and refuses older or unqualified newer versions", () => {
    expect(parseScopeRuntimeWorkerArguments([...invocation, CODEX_VERIFIED_VERSION, "7"])).toMatchObject({adapterId:"codex",harnessVersion:CODEX_VERIFIED_VERSION});
    for (const version of ["0.154.0", "0.156.1", "0.162.2"]) {
      expect(() => parseScopeRuntimeWorkerArguments([...invocation, version, "7"])).toThrow(expect.objectContaining({name:"ScopeRuntimeInvocationError"}));
    }
  });
});
