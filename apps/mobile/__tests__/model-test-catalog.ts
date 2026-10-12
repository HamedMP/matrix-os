import type { CanonicalProviderCatalog } from "@matrix-os/contracts";

import { createCanonicalProviderCatalogFixture } from "../../../tests/contracts/fixtures/canonical-chat";

export type Instance = CanonicalProviderCatalog["instances"][number];
type Model = Instance["models"][number];
type ModelSpec = [id: string, name: string, availability?: Model["availability"]];

export const SONNET = { instanceId: "matrix_pi_default", model: "anthropic:claude-sonnet-5" };
export const GLM = { instanceId: "matrix_pi_default", model: "cloudflare:@cf/zai-org/glm-5.3-flash" };
export const GPT = { instanceId: "codex_default", model: "gpt-5.6-sol" };

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
