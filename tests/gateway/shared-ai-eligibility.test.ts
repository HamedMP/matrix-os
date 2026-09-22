import {
  SCOPE_RUNTIME_CODEX_VERSION,
  SCOPE_RUNTIME_HARNESS_VERSION,
} from "@matrix-os/scope-runtime/profile";
import { describe, expect, it } from "vitest";
import {
  parseCollaborationAiEligibility,
  sharedAiAdapterFor,
  sharedAiEligibilitySupportsDriver,
} from "../../packages/gateway/src/collaboration/shared-ai-eligibility.js";
import { collaborationExecutionEligibility } from "./collaboration-test-support.js";

describe("shared AI execution eligibility", () => {
  const both = collaborationExecutionEligibility({ adapters: ["claude-code", "codex"] });
  const claudeOnly = collaborationExecutionEligibility();
  const codexOnly = collaborationExecutionEligibility({ adapters: ["codex"] });

  it("maps any Claude binding to the claude-code adapter without a synthetic Instance", () => {
    expect(sharedAiAdapterFor("claude_code", "claude_code_default")).toBe("claude-code");
    expect(sharedAiAdapterFor("claude_code", "claude_shared")).toBe("claude-code");
    expect(sharedAiAdapterFor("codex", "codex_default")).toBe("codex");
    expect(sharedAiAdapterFor("codex", "codex_other")).toBeUndefined();
  });

  it("verifies the production Claude binding against signed claude-code eligibility", () => {
    expect(sharedAiEligibilitySupportsDriver(claudeOnly, "claude_code", "claude_code_default")).toBe(true);
    expect(sharedAiEligibilitySupportsDriver(JSON.stringify(both), "claude_code", "claude_code_default"))
      .toBe(false);
    expect(sharedAiEligibilitySupportsDriver(both, "claude_code", "claude_code_default")).toBe(true);
    expect(sharedAiEligibilitySupportsDriver(codexOnly, "claude_code", "claude_code_default")).toBe(false);
  });

  it("admits the isolated Codex adapter only for its pinned Instance", () => {
    expect(sharedAiEligibilitySupportsDriver(both, "codex", "codex_default")).toBe(true);
    expect(sharedAiEligibilitySupportsDriver(codexOnly, "codex", "codex_default")).toBe(true);
    expect(sharedAiEligibilitySupportsDriver(claudeOnly, "codex", "codex_default")).toBe(false);
    expect(sharedAiEligibilitySupportsDriver(both, "codex", "codex_other")).toBe(false);
  });

  it("rejects eligibility that is not signed for this build's profile and harness versions", () => {
    expect(sharedAiEligibilitySupportsDriver({ ...both, profileDigest: "a".repeat(64) },
      "claude_code", "claude_code_default")).toBe(false);
    expect(sharedAiEligibilitySupportsDriver({ ...both, profileVersion: 1 },
      "claude_code", "claude_code_default")).toBe(false);
    expect(sharedAiEligibilitySupportsDriver({
      ...both,
      adapters: [{ adapterId: "claude-code", harnessVersion: "9.9.9" }],
    }, "claude_code", "claude_code_default")).toBe(false);
    expect(sharedAiEligibilitySupportsDriver({
      ...both,
      adapters: [{ adapterId: "codex", harnessVersion: "0.0.1" }],
    }, "codex", "codex_default")).toBe(false);
    expect(sharedAiEligibilitySupportsDriver({
      ...both,
      adapters: [...both.adapters, ...both.adapters],
    }, "codex", "codex_default")).toBe(false);
    expect(sharedAiEligibilitySupportsDriver(null, "claude_code", "claude_code_default")).toBe(false);
  });

  it("normalizes the legacy single-adapter shape to the multi-adapter shape", () => {
    const { adapters: _adapters, ...profile } = claudeOnly;
    expect(parseCollaborationAiEligibility({
      ...profile,
      adapterId: "claude-code",
      harnessVersion: SCOPE_RUNTIME_HARNESS_VERSION,
    })).toEqual(claudeOnly);
    expect(parseCollaborationAiEligibility(both)).toEqual({
      ...profile,
      adapters: [
        { adapterId: "claude-code", harnessVersion: SCOPE_RUNTIME_HARNESS_VERSION },
        { adapterId: "codex", harnessVersion: SCOPE_RUNTIME_CODEX_VERSION },
      ],
    });
    expect(() => parseCollaborationAiEligibility({
      ...profile,
      adapterId: "codex",
      harnessVersion: SCOPE_RUNTIME_CODEX_VERSION,
    })).toThrow();
  });
});
