import type { AiModelDescriptorView } from "@matrix-os/contracts";
import {
  KERNEL_EFFORTS,
  KERNEL_MODELS,
  LEGACY_KERNEL_MODEL_IDS,
  resolveKernelModelOption,
} from "../kernel-settings.js";

export const AI_PROVIDER_CATALOG_VERSION = "bundled_2026_09_10";
export const MATRIX_DEFAULT_MODEL_ID = "@cf/zai-org/glm-5.3-flash";
export const MATRIX_INCLUDED_MODEL_IDS = ["claude-sonnet-5"] as const;
export const OWNER_ANTHROPIC_MODEL_IDS = [
  "claude-fable-5",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-haiku-4-5",
  ...LEGACY_KERNEL_MODEL_IDS,
] as const;
export const OWNER_OPENAI_MODEL_IDS = ["provider-default"] as const;

const CURRENT_STATUS = new Map<string, "current">(
  KERNEL_MODELS.map((model) => [model.id, "current"]),
);

export function buildBundledModelCatalog(): AiModelDescriptorView[] {
  const modelIds = [
    ...new Set([
      ...KERNEL_MODELS.map((model) => model.id),
      ...LEGACY_KERNEL_MODEL_IDS,
    ]),
  ];

  const anthropicModels: AiModelDescriptorView[] = modelIds.map((id) => {
    const option = resolveKernelModelOption(id);
    const eligibleAccessSourceIds = [
      ...(MATRIX_INCLUDED_MODEL_IDS.includes(id as (typeof MATRIX_INCLUDED_MODEL_IDS)[number])
        ? ["matrix_included"]
        : []),
      ...(OWNER_ANTHROPIC_MODEL_IDS.includes(id as (typeof OWNER_ANTHROPIC_MODEL_IDS)[number])
        ? ["owner_anthropic_key", "owner_anthropic_profile"]
        : []),
    ];
    return {
      id,
      vendor: "anthropic" as const,
      displayName: option.label,
      status: CURRENT_STATUS.get(id) ?? "legacy" as const,
      capabilities: ["tools", "vision", "reasoning", "long_context"],
      effortControls: [...KERNEL_EFFORTS],
      eligibleAccessSourceIds,
      dataPolicies: eligibleAccessSourceIds.map((accessSourceId) => ({
        accessSourceId,
        route: accessSourceId === "matrix_included"
          ? "matrix_relay" as const
          : "owner_direct" as const,
        disclosureKey: accessSourceId === "matrix_included"
          ? "matrix-cloudflare-anthropic"
          : "owner-direct-anthropic",
      })),
      aliases: [],
      catalogVersion: AI_PROVIDER_CATALOG_VERSION,
    };
  });
  return [
    {
      id: MATRIX_DEFAULT_MODEL_ID, vendor: "cloudflare", displayName: "GLM 5.3 Flash",
      status: "current", capabilities: ["tools", "reasoning", "long_context"],
      effortControls: [], eligibleAccessSourceIds: ["matrix_cloudflare"],
      dataPolicies: [{ accessSourceId: "matrix_cloudflare", route: "matrix_relay", disclosureKey: "matrix-cloudflare-workers-ai" }],
      aliases: [], catalogVersion: AI_PROVIDER_CATALOG_VERSION,
    },
    ...anthropicModels,
    {
      id: OWNER_OPENAI_MODEL_IDS[0],
      vendor: "openai",
      displayName: "Selected in Codex",
      status: "current",
      capabilities: ["tools", "vision", "reasoning", "long_context"],
      effortControls: [...KERNEL_EFFORTS],
      eligibleAccessSourceIds: ["owner_openai_profile"],
      dataPolicies: [{
        accessSourceId: "owner_openai_profile",
        route: "owner_direct",
        disclosureKey: "owner-direct-openai",
      }],
      aliases: [],
      catalogVersion: AI_PROVIDER_CATALOG_VERSION,
    },
  ];
}

export function eligibleModelsForSource(
  sourceId: string,
  catalog: readonly AiModelDescriptorView[],
): AiModelDescriptorView[] {
  return catalog.filter((model) => model.eligibleAccessSourceIds.includes(sourceId));
}
