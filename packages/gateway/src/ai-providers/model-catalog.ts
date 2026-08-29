import type { AiModelDescriptorView } from "@matrix-os/contracts";
import {
  KERNEL_EFFORTS,
  KERNEL_MODELS,
  LEGACY_KERNEL_MODEL_IDS,
  resolveKernelModelOption,
} from "../kernel-settings.js";

export const AI_PROVIDER_CATALOG_VERSION = "bundled_2026_08_29";
export const MATRIX_INCLUDED_MODEL_IDS = ["claude-sonnet-5"] as const;
export const OWNER_ANTHROPIC_MODEL_IDS = [
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-haiku-4-5",
  ...LEGACY_KERNEL_MODEL_IDS,
] as const;

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

  return modelIds.map((id) => {
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
      capabilities: ["tools", "vision", "reasoning", "long_context"] as const,
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
}

export function eligibleModelsForSource(
  sourceId: string,
  catalog: readonly AiModelDescriptorView[],
): AiModelDescriptorView[] {
  return catalog.filter((model) => model.eligibleAccessSourceIds.includes(sourceId));
}
