import { describe, expect, it } from "vitest";
import {
  CollaborationExecutionContextError,
  createScopeBoundExecutionContext,
  resolveScopeBoundResume,
} from "../../packages/gateway/src/collaboration/execution-context.js";

const scope = {
  scopeId: "d8efb31e-df17-4a90-bd92-7b2306e99c1f",
  resourceId: "chat_shared_1",
  authEpoch: "7",
  executionGeneration: "3",
  supervisorHandle: "runtime_22222222222222222222222222222222",
  profileId: "matrix-scope-v1",
  profileVersion: 1,
  profileDigest: "a".repeat(64),
} as const;

describe("collaboration execution context", () => {
  it("binds every shared Chat run to its scope, auth epoch, generation, and supervisor handle", () => {
    expect(createScopeBoundExecutionContext({
      ...scope,
      actorId: "user_editor",
      runId: "run_shared_1",
      adapterId: "claude-code",
      harnessVersion: "2.1.240",
    })).toEqual({
      version: 1,
      kind: "collaboration_scope",
      ...scope,
      actorId: "user_editor",
      runId: "run_shared_1",
      adapterId: "claude-code",
      harnessVersion: "2.1.240",
    });
  });

  it("resumes only state created inside the exact same scope boundary", () => {
    const context = createScopeBoundExecutionContext({
      ...scope,
      actorId: "user_editor",
      runId: "run_shared_2",
      adapterId: "claude-code",
      harnessVersion: "2.1.240",
    });
    const state = {
      schemaVersion: 4,
      value: { sessionId: "session_scope_only" },
      provenance: context,
    };

    expect(resolveScopeBoundResume({
      expected: context,
      state,
      parseState: (value) => value,
    })).toEqual({ sessionId: "session_scope_only" });

    for (const changed of [
      { scopeId: "e0e46120-8b7c-41fd-9f0b-7893239c4519" },
      { resourceId: "chat_sibling" },
      { authEpoch: "8" },
      { executionGeneration: "4" },
      { supervisorHandle: "runtime_33333333333333333333333333333333" },
      { profileDigest: "b".repeat(64) },
      { adapterId: "codex" },
      { harnessVersion: "2.1.33" },
    ]) {
      expect(() => resolveScopeBoundResume({
        expected: { ...context, ...changed },
        state,
        parseState: (value) => value,
      })).toThrow(CollaborationExecutionContextError);
    }
  });

  it("rejects legacy private and owner-scoped resume state instead of relabeling it", () => {
    const context = createScopeBoundExecutionContext({
      ...scope,
      actorId: "user_owner",
      runId: "run_shared_3",
      adapterId: "claude-code",
      harnessVersion: "2.1.240",
    });

    for (const state of [
      { schemaVersion: 4, value: { sessionId: "private" } },
      {
        schemaVersion: 4,
        value: { sessionId: "owner" },
        provenance: { version: 1, kind: "owner", ownerId: "user_owner" },
      },
      {
        schemaVersion: 4,
        value: { sessionId: "forged" },
        provenance: { ...context, kind: "collaboration_scope", command: "/bin/sh" },
      },
    ]) {
      expect(() => resolveScopeBoundResume({
        expected: context,
        state,
        parseState: (value) => value,
      })).toThrow(CollaborationExecutionContextError);
    }
  });
});
