import { describe, expect, it } from "vitest";
import { resolveScopeRuntimeHostConfig } from "@matrix-os/scope-runtime/host-config";
import { SCOPE_RUNTIME_PROFILE_ID, SCOPE_RUNTIME_HARNESS_VERSION } from "@matrix-os/scope-runtime/profile";
import {
  runtimeProfileIdentity, SCOPE_RUNTIME_BOT_PROFILE_ID, SCOPE_RUNTIME_MANAGED_PI_PROFILE_ID,
} from "@matrix-os/scope-runtime/bot-profile";
import {
  createGatewayScopeRuntimeProfilePolicy,
} from "../../packages/gateway/src/collaboration/scope-runtime-profile-policy.js";
import {
  parseCollaborationAiEligibility, SHARED_MATRIX_BOT_ELIGIBILITY,
} from "../../packages/gateway/src/collaboration/shared-ai-eligibility.js";
import { collaborationExecutionEligibility } from "./collaboration-test-support.js";

function config(namespace: string, owned = true) {
  const root = `/var/lib/matrix-devstack/${namespace}`;
  return resolveScopeRuntimeHostConfig({ env: {
    MATRIX_SCOPE_RUNTIME_NAMESPACE: namespace,
    MATRIX_HOME: root + "/home",
    MATRIX_SCOPE_RUNTIME_APP_ROOT: root + "/app",
    MATRIX_SCOPE_RUNTIME_NODE_ROOT: owned ? root + "/runtime/node" : undefined,
  } });
}
const local = config("profile-a");
const other = config("profile-b");
const legacy = collaborationExecutionEligibility({ adapters: ["claude-code", "codex"] });
function eligibility(deployment: typeof local) {
  return {
    ...legacy, ...runtimeProfileIdentity(SCOPE_RUNTIME_PROFILE_ID, deployment.ownedNode),
    matrixBot: {
      ...SHARED_MATRIX_BOT_ELIGIBILITY,
      ...runtimeProfileIdentity(SCOPE_RUNTIME_MANAGED_PI_PROFILE_ID, deployment.ownedNode),
    },
  };
}
const own = eligibility(local);
const foreign = eligibility(other);

describe("trusted Gateway scope runtime profile policy", () => {
  it("selects exactly the three local runtime identities", () => {
    const policy = createGatewayScopeRuntimeProfilePolicy(local);
    const ids = [SCOPE_RUNTIME_PROFILE_ID, SCOPE_RUNTIME_BOT_PROFILE_ID, SCOPE_RUNTIME_MANAGED_PI_PROFILE_ID];
    expect(Object.keys(policy.catalog).sort()).toEqual([...ids].sort());
    for (const id of ids) {
      const expected = runtimeProfileIdentity(id, local.ownedNode);
      expect(policy.catalog[id]).toMatchObject({
        profileDigest: expected.profileDigest, profileVersion: expected.profileVersion,
      });
    }
    expect(policy.sharedEligibility).toEqual({ ...legacy, profileDigest: own.profileDigest });
    expect(policy.matrixBotEligibility).toEqual(own.matrixBot);
  });

  it("retains installed digests and single-Claude normalization with no Node override", () => {
    const single = {
      ...runtimeProfileIdentity(SCOPE_RUNTIME_PROFILE_ID),
      adapterId: "claude-code", harnessVersion: SCOPE_RUNTIME_HARNESS_VERSION,
    };
    const withoutNamespace = resolveScopeRuntimeHostConfig({ env: {} });
    for (const deployment of [withoutNamespace, config("profile-a", false)]) {
      const policy = createGatewayScopeRuntimeProfilePolicy(deployment);
      for (const [id, entry] of Object.entries(policy.catalog)) {
        expect(entry.profileDigest).toBe(runtimeProfileIdentity(id).profileDigest);
      }
      expect(JSON.stringify(policy.sharedEligibility)).toBe(JSON.stringify(legacy));
      expect(JSON.stringify(policy.matrixBotEligibility)).toBe(JSON.stringify(SHARED_MATRIX_BOT_ELIGIBILITY));
      expect(policy.parseEligibility(single)).toStrictEqual(parseCollaborationAiEligibility(single));
      expect(policy.supportsDriver(own, "codex", "codex_default")).toBe(false);
    }
  });

  it("keeps policies isolated and immutable across concurrent namespaces", () => {
    const first = createGatewayScopeRuntimeProfilePolicy(local);
    const second = createGatewayScopeRuntimeProfilePolicy(other);
    expect(first.parseEligibility(own)).toEqual(own);
    expect(second.parseEligibility(foreign)).toEqual(foreign);
    expect(first.supportsDriver(foreign, "matrix_bot", "matrix_bot_default")).toBe(false);
    expect(second.supportsDriver(own, "codex", "codex_default")).toBe(false);
    const chat = first.catalog[SCOPE_RUNTIME_PROFILE_ID]!;
    expect(Reflect.set(chat.identity, "uidMin", 0)).toBe(false);
    expect(Reflect.set(chat.supportedAdapters.codex!.harnessVersions, 0, "0.0.0")).toBe(false);
    expect(Reflect.set(first.sharedEligibility.adapters, 0, {})).toBe(false);
    expect(Reflect.set(first.matrixBotEligibility, "profileDigest", foreign.matrixBot.profileDigest)).toBe(false);
  });

  it("enforces exact driver, adapter and Instance constraints within the configured identity", () => {
    const policy = createGatewayScopeRuntimeProfilePolicy(local);
    expect(policy.supportsDriver(own, "claude_code", "claude_code_default")).toBe(true);
    expect(policy.supportsDriver(own, "codex", "codex_default")).toBe(true);
    expect(policy.supportsDriver(own, "matrix_bot", "matrix_bot_default")).toBe(true);
    expect(policy.supportsDriver(own, "matrix_bot", "custom")).toBe(false);
    expect(policy.supportsDriver(own, "codex", "custom")).toBe(false);
    expect(policy.supportsDriver({ ...own, adapters: [own.adapters[0]] }, "codex", "codex_default")).toBe(false);
    expect(policy.supportsDriver({ ...own, matrixBot: undefined }, "matrix_bot", "matrix_bot_default")).toBe(false);
  });

  it.each(Object.entries({
    legacy,
    foreign,
    legacyChat: { ...own, profileDigest: legacy.profileDigest },
    foreignChat: { ...own, profileDigest: foreign.profileDigest },
    arbitrary: { ...own, profileDigest: "a".repeat(64) },
    legacyPi: { ...own, matrixBot: SHARED_MATRIX_BOT_ELIGIBILITY },
    foreignPi: { ...own, matrixBot: foreign.matrixBot },
    recipeBot: { ...own, matrixBot: { ...own.matrixBot, ...runtimeProfileIdentity(SCOPE_RUNTIME_BOT_PROFILE_ID, local.ownedNode) } },
    arbitraryPi: { ...own, matrixBot: { ...own.matrixBot, profileDigest: "b".repeat(64) } },
    wrongPiHarness: { ...own, matrixBot: { ...own.matrixBot, harnessVersion: "0.0.0" } },
    wrongPiAdapter: { ...own, matrixBot: { ...own.matrixBot, adapterId: "claude-code" } },
    unknownId: { ...own, profileId: "scope-runtime-unknown" },
    wrongPiVersion: { ...own, matrixBot: { ...own.matrixBot, profileVersion: 999 } },
    wrongPiWorkload: { ...own, matrixBot: { ...own.matrixBot, workload: "chat_ai" } },
    wrongVersion: { ...own, profileVersion: 999 },
    wrongHarness: { ...own, adapters: [{ adapterId: "codex", harnessVersion: "bad" }] },
    wrongAdapter: { ...own, adapters: [{ adapterId: "matrix-bot", harnessVersion: "1.0.0" }] },
    duplicates: { ...own, adapters: [...own.adapters, ...own.adapters] },
  }))("rejects %s even when identical invalid records are compared", (_label, invalid) => {
    const policy = createGatewayScopeRuntimeProfilePolicy(local);
    expect(() => policy.parseEligibility(invalid)).toThrow();
    expect(policy.supportsDriver(invalid, "claude_code", "claude_code_default")).toBe(false);
    expect(policy.eligibilityEquals(invalid, invalid)).toBe(false);
  });

  it("compares normalized eligibility including managed Pi appearance or loss", () => {
    const policy = createGatewayScopeRuntimeProfilePolicy(local);
    const { matrixBot: _pi, ...chat } = own;
    const single = { ...runtimeProfileIdentity(SCOPE_RUNTIME_PROFILE_ID, local.ownedNode), ...own.adapters[0] };
    expect(policy.eligibilityEquals(single, { ...chat, adapters: [own.adapters[0]] })).toBe(true);
    expect(policy.eligibilityEquals(own, structuredClone(own))).toBe(true);
    expect(policy.eligibilityEquals(chat, own)).toBe(false);
    expect(policy.eligibilityEquals(own, chat)).toBe(false);
    expect(policy.eligibilityEquals(null, null)).toBe(false);
  });
});
