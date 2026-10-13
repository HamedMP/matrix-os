import type { CanonicalProviderCatalog } from "@matrix-os/contracts";

import { createCanonicalProviderCatalogFixture } from "../../../tests/contracts/fixtures/canonical-chat";

export type Instance = CanonicalProviderCatalog["instances"][number];
type Model = Instance["models"][number];
type ModelSpec = [id: string, name: string, availability?: Model["availability"]];

export const SONNET = { instanceId: "matrix_pi_default", model: "anthropic:claude-sonnet-5" };
export const GLM = { instanceId: "matrix_pi_default", model: "cloudflare:@cf/zai-org/glm-5.3-flash" };
export const GPT = { instanceId: "codex_default", model: "gpt-5.6-sol" };
export const PLAN = { instanceId: "matrix_pi_chatgpt_plan", model: "gpt-5.6-sol" };

/** An engine's entry in the catalog: available, with the given models and no options. */
export function engineInstance(
  id: string,
  driverKind: Instance["driverKind"],
  displayName: string,
  models: ModelSpec[],
  overrides: Partial<Instance> = {},
): Instance {
  const { defaultSelection: _default, ...base } = createCanonicalProviderCatalogFixture().instances[0]!;
  return {
    ...base,
    id,
    driverKind,
    displayName,
    models: models.map(([modelId, name, availability = "available"]) => ({
      ...base.models[0]!,
      id: modelId,
      displayName: name,
      availability,
    })),
    ...overrides,
  };
}

export function catalogOf(...instances: Instance[]): CanonicalProviderCatalog {
  return { ...createCanonicalProviderCatalogFixture(), instances };
}

/** Matrix AI's own route, as the computer lists it. */
export function matrixInstance(models: ModelSpec[] = [[SONNET.model, "Sonnet 5"]], overrides: Partial<Instance> = {}): Instance {
  return engineInstance(SONNET.instanceId, "matrix_pi", "Pi", models, { connectionLabel: "Matrix AI", ...overrides });
}

export function codexInstance(models: ModelSpec[] = [[GPT.model, "GPT-5.6-Sol"]], overrides: Partial<Instance> = {}): Instance {
  return engineInstance(GPT.instanceId, "codex", "Codex", models, overrides);
}

/** The account a route through the person's own ChatGPT subscription is bound to. */
export function planBinding(accountId = "acct_first", grantRevision = "1") {
  return [{ id: "accountId", value: accountId }, { id: "grantRevision", value: grantRevision }];
}

/** Matrix AI through the person's ChatGPT subscription, as the computer lists it while that account is connected. */
export function planInstance(
  models: ModelSpec[] = [[PLAN.model, "GPT-5.6-Sol"]],
  binding = planBinding(),
  overrides: Partial<Instance> = {},
): Instance {
  return engineInstance(PLAN.instanceId, "matrix_pi", "Codex · ChatGPT subscription", models, {
    options: binding.map(({ id, value }) => ({
      id,
      label: id === "accountId" ? "Account" : "Authorization",
      kind: "enum",
      placement: "advanced",
      values: [{ value, label: "Current" }],
      defaultValue: value,
    })),
    ...(models[0] ? { defaultSelection: { instanceId: PLAN.instanceId, model: models[0][0], options: binding } } : {}),
    ...overrides,
  });
}

export const API_KEY = { instanceId: "matrix_pi_anthropic_api", model: "claude-sonnet-5" };

/** The connection a route through the person's own Anthropic API key is bound to. */
export function apiKeyBinding(credentialGeneration = "0b1f6a52-3c1e-4c7a-9d0e-2f6a8b1c4d5e", connectionRevision = "1") {
  return [{ id: "connectionRevision", value: connectionRevision }, { id: "credentialGeneration", value: credentialGeneration }];
}

/** Matrix AI through the person's Anthropic API key, as the computer lists it while that key is connected. */
export function apiKeyInstance(binding = apiKeyBinding()): Instance {
  return engineInstance(API_KEY.instanceId, "matrix_pi", "Matrix AI · Anthropic API", [[API_KEY.model, "Sonnet 5"]], {
    connectionLabel: "Anthropic API",
    options: binding.map(({ id, value }) => ({
      id,
      label: id === "connectionRevision" ? "Connection" : "Credential",
      kind: "enum",
      placement: "advanced",
      values: [{ value, label: "Current connection" }],
      defaultValue: value,
    })),
    defaultSelection: { ...API_KEY, options: binding },
  });
}

/** The same subscription as agents run through it: a route no chat can be started on. */
export function planAgentInstance(): Instance {
  const base = engineInstance("matrix_chatgpt_plan", "matrix_bot", "ChatGPT subscription", [[PLAN.model, "GPT-5.6-Sol"]]);
  return { ...base, supports: { ...base.supports, rootChat: false } };
}

export const REASONING: Instance["options"][number] = {
  id: "effort",
  label: "Reasoning",
  kind: "enum",
  placement: "composer",
  defaultValue: "medium",
  values: [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
  ],
};
