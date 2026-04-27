import { describe, expect, it } from "vitest";
import { recoveryHintForCode } from "../../packages/sync-client/src/cli/recovery-hints.js";

describe("CLI recovery hints", () => {
  it("maps stable shell and daemon codes to actionable hints", () => {
    expect(recoveryHintForCode("session_not_found")).toContain("matrix shell new");
    expect(recoveryHintForCode("session_exists")).toContain("matrix shell attach");
    expect(recoveryHintForCode("invalid_layout")).toContain("matrix shell layout");
    expect(recoveryHintForCode("unsupported_version")).toContain("update");
    expect(recoveryHintForCode("attach_failed")).toContain("reattach");
  });
});
