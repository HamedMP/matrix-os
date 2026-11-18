import {
  SCOPE_RUNTIME_CODEX_VERSION,
  SCOPE_RUNTIME_HARNESS_VERSION,
} from "@matrix-os/scope-runtime/profile";
import { SCOPE_RUNTIME_BOT_PROFILE_ID, SCOPE_RUNTIME_BOT_PROFILE_VERSION, SCOPE_RUNTIME_BOT_PROFILE_DIGEST, SCOPE_RUNTIME_MANAGED_PI_PROFILE_ID, SCOPE_RUNTIME_MANAGED_PI_PROFILE_VERSION, SCOPE_RUNTIME_MANAGED_PI_PROFILE_DIGEST, SCOPE_RUNTIME_BOT_ADAPTER_ID, SCOPE_RUNTIME_BOT_HARNESS_VERSION } from "@matrix-os/scope-runtime/bot-profile";
import { describe, expect, it } from "vitest";
import {
  parseCollaborationAiEligibility,
  sharedAiAdapterFor,
  sharedAiEligibilitySupportsDriver,
} from "../../packages/gateway/src/collaboration/shared-ai-eligibility.js";
import { resolveCurrentOwnerRoute } from "../../packages/gateway/src/collaboration/shared-run-owner-source.js";
import { collaborationExecutionEligibility } from "./collaboration-test-support.js";
import { makeAiProviderSnapshot } from "../fixtures/ai-provider-snapshot.js";

function ownerRouteSnapshot() {
  const base = makeAiProviderSnapshot();
  return {
    ...base,
    revision: 7,
    instances: base.instances.map((instance) => ({
      ...instance,
      id: "claude_code_default",
      driverId: "claude_code",
    })),
    active: {
      providerInstanceId: "claude_code_default",
      accessSourceId: "matrix_included",
      modelId: "claude-sonnet-5",
    },
  };
}

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

describe("current owner Provider Settings route", () => {
  it("resolves only the exact active instance, source, and model with immutable freshness", () => {
    expect(resolveCurrentOwnerRoute(ownerRouteSnapshot(), Date.parse("2026-08-29T21:00:01.000Z")))
      .toMatchObject({
        settingsRevision: "7",
        harness: "claude_code",
        providerInstanceId: "claude_code_default",
        accessSourceId: "matrix_included",
        modelId: "claude-sonnet-5",
        effectiveSubmitMode: "members",
      });
  });

  it("fails closed when the active route is absent or unavailable even if another route is ready", () => {
    const ready = ownerRouteSnapshot();
    expect(resolveCurrentOwnerRoute({
      ...ready,
      active: { providerInstanceId: null, accessSourceId: null, modelId: null },
    }, Date.parse("2026-08-29T21:00:01.000Z"))).toBeNull();

    const unavailable = {
      ...ready,
      accessSources: ready.accessSources.map((source) => source.id === "matrix_included"
        ? { ...source, state: "disabled" as const, action: "retry" as const, safeReason: "policy" as const }
        : source),
      instances: [...ready.instances, { ...ready.instances[0]!, id: "ready_but_not_active" }],
    };
    expect(resolveCurrentOwnerRoute(unavailable, Date.parse("2026-08-29T21:00:01.000Z"))).toBeNull();
  });
});


describe("separate matrix bot shared eligibility", () => {
  const standard = collaborationExecutionEligibility();
  const matrixBot = { profileId: SCOPE_RUNTIME_MANAGED_PI_PROFILE_ID, profileVersion: SCOPE_RUNTIME_MANAGED_PI_PROFILE_VERSION,
    profileDigest: SCOPE_RUNTIME_MANAGED_PI_PROFILE_DIGEST, adapterId: SCOPE_RUNTIME_BOT_ADAPTER_ID,
    harnessVersion: SCOPE_RUNTIME_BOT_HARNESS_VERSION, workload: "bot_agent" };
  it("requires the launched managed profile and exact Matrix bot instance", () => {
    expect(sharedAiEligibilitySupportsDriver(standard, "matrix_bot", "matrix_bot_default")).toBe(false);
    expect(sharedAiEligibilitySupportsDriver({ ...standard, matrixBot }, "matrix_bot", "matrix_bot_default")).toBe(true);
    expect(sharedAiEligibilitySupportsDriver({ ...standard, matrixBot: { ...matrixBot, profileId: SCOPE_RUNTIME_BOT_PROFILE_ID, profileVersion: SCOPE_RUNTIME_BOT_PROFILE_VERSION, profileDigest: SCOPE_RUNTIME_BOT_PROFILE_DIGEST } }, "matrix_bot", "matrix_bot_default")).toBe(false);
    expect(sharedAiEligibilitySupportsDriver({ ...standard, matrixBot }, "matrix_bot", "other_bot")).toBe(false);
    expect(sharedAiEligibilitySupportsDriver({ ...standard, matrixBot: { ...matrixBot, profileDigest: "a".repeat(64) } }, "matrix_bot", "matrix_bot_default")).toBe(false);
    expect(sharedAiEligibilitySupportsDriver({ ...standard, matrixBot: { ...matrixBot, profileVersion: SCOPE_RUNTIME_MANAGED_PI_PROFILE_VERSION + 1 } }, "matrix_bot", "matrix_bot_default")).toBe(false);
    expect(sharedAiEligibilitySupportsDriver({ ...standard, matrixBot: { ...matrixBot, workload: "chat_ai" } }, "matrix_bot", "matrix_bot_default")).toBe(false);
    expect(sharedAiEligibilitySupportsDriver({ ...standard, adapters: [{ adapterId: "matrix-bot", harnessVersion: SCOPE_RUNTIME_BOT_HARNESS_VERSION }] }, "matrix_bot", "matrix_bot_default")).toBe(false);
  });
});
