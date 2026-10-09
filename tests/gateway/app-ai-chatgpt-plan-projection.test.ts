import { expect, it } from "vitest";
import { AiProviderSnapshotV3Schema, type BotProviderConnection } from "@matrix-os/contracts";
import { projectChatGptPlanSnapshot, projectChatGptPlanAppRoutes } from "../../packages/gateway/src/app-ai/chatgpt-plan-projection.js";
const base = { contractVersion: 3 as const, revision: 0, refreshedAt: "2026-10-08T10:00:00.000Z", accessSources: [], accounts: [], drivers: [], instances: [], models: [], active: { providerInstanceId: null, accessSourceId: null, modelId: null } };
const now = new Date("2026-10-08T10:00:00.000Z");
const source: BotProviderConnection = { id: "matrix_chatgpt_plan", providerId: "openai", executionKind: "direct_pi", availability: "available", accountId: "account-own", models: [{ id: "gpt-own", displayName: "Own model" }], authorization: { revision: 3, enabled: true, background: false }, coordinatorFunding: "subscription" };
it("projects one canonical source/account/instance/model with short live freshness", () => {
  const snapshot = projectChatGptPlanSnapshot(base, source, now);
  expect(AiProviderSnapshotV3Schema.safeParse(snapshot).success).toBe(true);
  expect(snapshot.instances[0]).toMatchObject({ id: "matrix_chatgpt_plan", accountId: "account-own", accessSourceId: "matrix_chatgpt_plan", modelIds: ["gpt-own"], defaultModelId: "gpt-own" });
  expect(snapshot.accessSources[0]).toMatchObject({ fundingKind: "owner_account", state: "ready", checkedAt: now.toISOString(), staleAfter: "2026-10-08T10:00:30.000Z", policyVersion: "chatgpt-plan-3" });
  expect(snapshot.accounts[0]).toMatchObject({ id: "account-own", authMethod: "oauth_pkce" });
  expect(snapshot.active).toEqual(base.active);
  expect(base.accessSources).toEqual([]);
});
it("absent authority contributes no ready source", () => {
  expect(projectChatGptPlanSnapshot(base, undefined, now)).toEqual(base);
});
it("disabled grants preserve account metadata but never ready models", () => {
  const disabled = { ...source, availability: "setup_required" as const, unavailableReason: "authorization_required" as const, authorization: { revision: 4, enabled: false, background: false } };
  const snapshot = projectChatGptPlanSnapshot(base, disabled, now);
  expect(snapshot.accessSources[0]).toMatchObject({ state: "disabled", eligibleModelIds: [] });
  expect(snapshot.instances[0]).toMatchObject({ readiness: { state: "disabled" }, modelIds: [], defaultModelId: null });
});
it("replaces stale prior projection on absent peer and preserves other sources", () => {
  const prior = projectChatGptPlanSnapshot(base, source, now);
  const next = projectChatGptPlanSnapshot(prior, { id: "matrix_chatgpt_plan", providerId: "openai", executionKind: "direct_pi", availability: "unavailable", unavailableReason: "unsupported_runtime", models: [], authorization: { revision: 0, enabled: false, background: false }, coordinatorFunding: "subscription" }, now);
  expect(next.accounts).toEqual([]);
  expect(next.instances[0]).toMatchObject({ accountId: null, modelIds: [], defaultModelId: null });
  expect(next.models).toEqual([]);
  expect(next.accessSources[0]).toMatchObject({ state: "unavailable" });
});
it("merges model eligibility without overwriting another route's policy", () => {
  const prior = projectChatGptPlanSnapshot(base, source, now);
  const shared = { ...prior, accessSources: [{ ...prior.accessSources[0]!, id: "other" }], accounts: [], drivers: [], instances: [], models: [{ ...prior.models[0]!, eligibleAccessSourceIds: ["other"], dataPolicies: [{ accessSourceId: "other", route: "owner_direct" as const, disclosureKey: "other-policy" }] }] };
  const next = projectChatGptPlanSnapshot(shared, source, now);
  expect(next.models[0]!.eligibleAccessSourceIds).toEqual(["other", "matrix_chatgpt_plan"]);
  expect(next.models[0]!.dataPolicies[0]).toEqual(shared.models[0]!.dataPolicies[0]);
});
it("preserves unrelated catalog models with no eligible route", () => {
  const prior = projectChatGptPlanSnapshot(base, source, now);
  const idle = { ...prior.models[0]!, id: "gpt-idle", eligibleAccessSourceIds: [], dataPolicies: [] };
  const snapshot = projectChatGptPlanSnapshot({ ...base, models: [idle] }, source, now);
  expect(snapshot.models).toContainEqual(idle);
});
it("app discovery derives exact canonical truth and requires its adapter", () => {
  const snapshot = projectChatGptPlanSnapshot(base, source, now);
  expect(projectChatGptPlanAppRoutes(snapshot, true, +now)).toEqual([{ harnessId: "matrix_chatgpt_plan", accountId: "account-own", accessSourceId: "matrix_chatgpt_plan", modelId: "gpt-own", displayName: "ChatGPT subscription", availability: "available", readiness: "ready", reason: null }]);
  expect(projectChatGptPlanAppRoutes(snapshot, false, +now)[0]).toMatchObject({ availability: "unavailable", reason: "completion_unavailable" });
  expect(projectChatGptPlanAppRoutes(snapshot, true, +now + 30000)[0]).toMatchObject({ availability: "unavailable", reason: "not_ready" });
});
it("isolates account identity collisions without rewriting native readiness", () => {
  const prior = projectChatGptPlanSnapshot(base, source, now);
  const account = { ...prior.accounts[0]!, authMethod: "provider_profile" as const, state: "unknown" as const, action: "retry" as const };
  const native = { ...base, accounts: [account] };
  const projected = projectChatGptPlanSnapshot(native, source, now);
  expect(projected).toEqual(native);
});
it("isolates vendor/model collisions and unrepresentable IDs", () => {
  const prior = projectChatGptPlanSnapshot(base, source, now);
  const incompatible = { ...prior.models[0]!, vendor: "anthropic" as const, eligibleAccessSourceIds: [], dataPolicies: [] };
  const other = { ...base, models: [incompatible] };
  expect(projectChatGptPlanSnapshot(other, source, now)).toEqual(other);
  expect(projectChatGptPlanSnapshot(base, { ...source, accountId: "a".repeat(140) }, now)).toEqual(base);
});
