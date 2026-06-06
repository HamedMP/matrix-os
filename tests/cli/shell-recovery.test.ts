import { describe, expect, it } from "vitest";
import { recoveryHintForCode } from "../../packages/sync-client/src/cli/recovery-hints.js";

describe("CLI recovery hints", () => {
  it("maps stable shell and daemon codes to actionable hints", () => {
    expect(recoveryHintForCode("session_not_found")).toContain("mos shell new");
    expect(recoveryHintForCode("session_exists")).toContain("mos shell attach");
    expect(recoveryHintForCode("invalid_layout")).toContain("mos shell layout");
    expect(recoveryHintForCode("unsupported_version")).toContain("update");
    expect(recoveryHintForCode("attach_failed")).toContain("Reattach");
    expect(recoveryHintForCode("attach_timeout")).toContain("mos doctor");
    expect(recoveryHintForCode("auth_expired")).toContain("mos login");
  });
});
