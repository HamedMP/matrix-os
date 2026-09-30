import { describe, expect, it } from "vitest";
import { classifyCollaborationClientError, classifyCollaborationFailure } from "../../packages/ui/src/collaboration/failure-classification.js";

describe("collaboration failure classification", () => {
  it.each([
    [{ status: 503, code: "unavailable" }, "unavailable", true],
    [{ status: 503, code: "host_offline" }, "host_offline", true],
    [{ status: 426, code: "upgrade_required" }, "upgrade_required", false],
    [{ status: 429, code: "relay_limit", retryAfterSeconds: 25 }, "relay_limit", false],
    [{ status: 404, code: "not_found" }, "access_removed", false],
    [{ status: 403, code: "forbidden" }, "forbidden", false],
    [{ status: 401, code: "unauthorized" }, "unauthorized", false],
    [{ status: 404, code: "resource_missing" }, "resource_missing", false],
    [{ status: 423, code: "paused" }, "paused", false],
  ] as const)("maps %j to %s", (failure, state, reconnect) => {
    expect(classifyCollaborationFailure(failure)).toMatchObject({ state, reconnect });
  });

  it("fails closed on mismatched status and code without showing raw provider text", () => {
    expect(classifyCollaborationFailure({ status: 503, code: "not_found", error: "postgres://secret" }))
      .toEqual({ state: "unavailable", reconnect: true, message: "Collaboration is unavailable. Try again." });
  });

  it("recognizes a safe direct-client cause without showing its raw message", () => {
    const thrown = new Error("CollaborationUnavailable", { cause: { code: "access_removed", message: "postgres://secret" } });
    expect(classifyCollaborationClientError(thrown)).toEqual({
      state: "access_removed", reconnect: false, message: "This item is no longer shared with you.",
    });
  });

  it("does not tell a closed direct session to sign in again", () => {
    expect(classifyCollaborationClientError({ code: "denied" })).toMatchObject({ state: "unavailable" });
  });
});
