import { expect, it } from "vitest";
import { RoutineFullAccessStatusSchema, RoutineFullAccessCreateChallengeSchema, RoutineFullAccessRevokeSchema } from "@matrix-os/contracts";

it("exports one strict shared Full Access view decoder rather than accepting server-only authority fields", () => {
  const schema = RoutineFullAccessStatusSchema;
  expect(typeof schema?.safeParse).toBe("function");
  const view = { revision: 0, eligibility: "eligible", consent: null, challenge: null, origin: "browser_required" };
  expect(schema.safeParse(view).success).toBe(true);
  for (const patch of [{ nonce: "not-public" }, { revision: -1 }, { origin: "device_verified" }, { eligibility: "authorized" }]) {
    expect(schema.safeParse({ ...view, ...patch }).success).toBe(false);
  }
});

it("accepts only the safe fixed action/target/expiry projection and strict revision commands", () => {
  const scope = { expiresAt: "2026-11-05T10:00:00.000Z", policyRevision: 1, actions: ["read", "propose", "control"],
    target: { botId: "bot_abcdefgh", chatId: "chat_owner" } };
  const view = { revision: 1, eligibility: "eligible", origin: "browser_required",
    consent: { ...scope, scopeId: `rcfull_${"a".repeat(32)}` },
    challenge: { ...scope, challengeId: `rcfull_${"b".repeat(32)}`, scopeDigest: "c".repeat(64) } };
  expect(RoutineFullAccessStatusSchema.safeParse(view).success).toBe(true);
  for (const patch of [{ nonce: "server-only" }, { actions: ["read", "propose", "control", "background"] }, { expiresAt: "tomorrow" },
    { target: { botId: "forged", chatId: "chat_owner" } }, { target: { botId: "bot_abcdefgh", chatId: "invalid" } }]) {
    expect(RoutineFullAccessStatusSchema.safeParse({ ...view, consent: { ...view.consent, ...patch } }).success).toBe(false);
  }
  for (const schema of [RoutineFullAccessCreateChallengeSchema, RoutineFullAccessRevokeSchema]) {
    expect(schema.safeParse({ baseRevision: 0 }).success).toBe(true);
    for (const body of [{}, { baseRevision: -1 }, { baseRevision: 0, ownerId: "model" }, { baseRevision: 0, permissionMode: "full_access" }]) {
      expect(schema.safeParse(body).success).toBe(false);
    }
  }
});
