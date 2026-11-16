import { describe, expect, it } from "vitest";
import {
  activeFundedCanaryBinding, effectiveFundedCanaryPolicy, loadFundedCanaryBinding,
} from "../../packages/platform/src/ai-funded-canary.js";

const now = new Date("2026-11-16T08:00:00.000Z");
const expiresAt = "2026-11-16T09:00:00.000Z";
const identity = {
  ownerId: "user_fundedAcceptance",
  machineId: "b971aa9e-4777-48cd-a8e0-d79d4cb0be48",
  runtimeSlot: "primary",
};
const sourceSha = "22ed178caaca" + "a".repeat(28);
const env = {
  MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED: "true",
  MATRIX_FUNDED_AI_RELAY_URL: "https://matrix-ai-relay-production-abcdefghij-ey.a.run.app",
  MATRIX_FUNDED_AI_CANARY_BINDING: JSON.stringify({ ...identity, runtimeTokenEpoch: 4, sourceSha, expiresAt }),
};
const fullGlm = "@cf/zai-org/glm-5.3";
const deepSeek = "@cf/deepseek-ai/deepseek-v4.1-flash-1017";

describe("funded production test binding", () => {
  it("defaults off and naturally expires without blocking a restart", () => {
    expect(loadFundedCanaryBinding({}, now)).toBeUndefined();
    expect(loadFundedCanaryBinding(env, new Date(expiresAt))).toBeUndefined();
  });

  it("derives the candidate only from the reviewed source and canonical Relay origin", () => {
    expect(loadFundedCanaryBinding(env, now)).toEqual({
      identity, runtimeTokenEpoch: 4, expiresAt,
      relayOrigin: "https://relay-22ed178caaca---matrix-ai-relay-production-abcdefghij-ey.a.run.app",
    });
    const value = JSON.parse(env.MATRIX_FUNDED_AI_CANARY_BINDING);
    expect(() => loadFundedCanaryBinding({ ...env, MATRIX_FUNDED_AI_CANARY_BINDING: JSON.stringify({
      ...value, relayOrigin: "https://collector.example.com",
    }) }, now)).toThrow("Funded AI canary binding is misconfigured");
    for (const origin of ["https://matrix-ai-relay-staging-abcdefghij-ey.a.run.app", "https://matrix-ai-relay-production-abcdefghij-ey.a.run.app/other"]) {
      expect(() => loadFundedCanaryBinding({ ...env, MATRIX_FUNDED_AI_RELAY_URL: origin }, now)).toThrow();
    }
  });

  it("rejects excessive or invalid deadlines and leaves the control-plane kill switch authoritative", () => {
    const value = JSON.parse(env.MATRIX_FUNDED_AI_CANARY_BINDING);
    for (const expiry of ["2026-11-16T14:00:00.001Z", "2026-02-31T09:00:00.000Z"]) {
      expect(() => loadFundedCanaryBinding({ ...env, MATRIX_FUNDED_AI_CANARY_BINDING: JSON.stringify({
        ...value, expiresAt: expiry,
      }) }, now)).toThrow();
    }
    expect(loadFundedCanaryBinding({ ...env, MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED: "false" }, now)).toBeUndefined();
  });

  it("requires an exact identity and epoch and never mutates ordinary model policy", () => {
    const binding = loadFundedCanaryBinding(env, now);
    const original = [fullGlm];
    const runtime = [fullGlm, deepSeek];
    expect(activeFundedCanaryBinding(binding, identity, 4, now)).toBe(binding);
    expect(effectiveFundedCanaryPolicy(original, runtime, binding, identity, 4, now)).toEqual({
      allowedModelIds: runtime, canaryExpiresAt: expiresAt,
    });
    expect(original).toEqual([fullGlm]);
    expect(effectiveFundedCanaryPolicy(runtime, runtime, binding, identity, 4, now)).toEqual({ allowedModelIds: runtime });
    expect(effectiveFundedCanaryPolicy(original, [deepSeek], binding, identity, 4, now)).toEqual({ allowedModelIds: [] });
    expect(effectiveFundedCanaryPolicy([], runtime, binding, identity, 4, now)).toEqual({ allowedModelIds: [] });
    for (const other of [{ ...identity, ownerId: "user_other" }, { ...identity, machineId: "other" }, { ...identity, runtimeSlot: "agent" }]) {
      expect(effectiveFundedCanaryPolicy(original, runtime, binding, other, 4, now)).toEqual({ allowedModelIds: original });
    }
    expect(effectiveFundedCanaryPolicy(original, runtime, binding, identity, 5, now)).toEqual({ allowedModelIds: original });
    expect(effectiveFundedCanaryPolicy(original, runtime, binding, identity, 4, new Date(expiresAt))).toEqual({ allowedModelIds: original });
  });
});
