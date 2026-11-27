import {
  ALIBABA_QWEN_37_PLUS_MODEL_ID, ALIBABA_QWEN_37_PLUS_PREVIEW_MAX_OUTPUT_TOKENS,
  GOOGLE_GEMINI_38_FLASH_MODEL_ID, GOOGLE_GEMINI_38_FLASH_PREVIEW_MAX_OUTPUT_TOKENS,
  MANAGED_WORKERS_AI_MODELS, MANAGED_WORKERS_AI_MODEL_IDS, MATRIX_BEDROCK_SOURCE_ID,
  MATRIX_PI_BEDROCK_GPT_OSS_120B_ID,
  MOONSHOT_KIMI_K31_PRO_MODEL_ID, MOONSHOT_KIMI_K31_PRO_PREVIEW_MAX_OUTPUT_TOKENS, retiredManagedWorkersAiModel,
  type AiModelDescriptorView,
} from "@matrix-os/contracts";
import {
  KERNEL_EFFORTS,
  KERNEL_MODELS,
  LEGACY_KERNEL_MODEL_IDS,
  resolveKernelModelOption,
} from "../kernel-settings.js";

export const AI_PROVIDER_CATALOG_VERSION = "bundled_2026_11_12";
export const MATRIX_DEFAULT_MODEL_ID = MANAGED_WORKERS_AI_MODEL_IDS[0];
export const MATRIX_INCLUDED_MODEL_IDS = ["claude-sonnet-5"] as const;
export const OWNER_ANTHROPIC_MODEL_IDS = [
  "claude-fable-5",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-haiku-4-5",
  ...LEGACY_KERNEL_MODEL_IDS,
] as const;
export const OWNER_OPENAI_MODEL_IDS = ["provider-default"] as const;

export const FUNDED_PREVIEW_CHAT_ROUTES = [
  { modelId: GOOGLE_GEMINI_38_FLASH_MODEL_ID, sourceId: "matrix_google_preview", vendor: "google",
    displayName: "Gemini 3.8 Flash", disclosureKey: "matrix-cloudflare-google",
    maxOutputTokens: GOOGLE_GEMINI_38_FLASH_PREVIEW_MAX_OUTPUT_TOKENS },
  { modelId: MOONSHOT_KIMI_K31_PRO_MODEL_ID, sourceId: "matrix_moonshot_preview", vendor: "moonshotai",
    displayName: "Kimi K3.1 Pro", disclosureKey: "matrix-cloudflare-moonshot",
    maxOutputTokens: MOONSHOT_KIMI_K31_PRO_PREVIEW_MAX_OUTPUT_TOKENS },
  { modelId: ALIBABA_QWEN_37_PLUS_MODEL_ID, sourceId: "matrix_alibaba_preview", vendor: "alibaba",
    displayName: "Qwen 3.7 Plus", disclosureKey: "matrix-cloudflare-alibaba",
    maxOutputTokens: ALIBABA_QWEN_37_PLUS_PREVIEW_MAX_OUTPUT_TOKENS },
] as const;

const CURRENT_STATUS = new Map<string, "current">(
  KERNEL_MODELS.map((model) => [model.id, "current"]),
);

export function buildBundledModelCatalog(
  observedMatrixIncludedModelIds: readonly string[] = [],
  effectiveBedrockModelIds: ReadonlySet<string> = new Set(),
): AiModelDescriptorView[] {
  const matrixIncludedModelIds = new Set<string>([
    ...MATRIX_INCLUDED_MODEL_IDS,
    ...observedMatrixIncludedModelIds,
  ]);
  const modelIds = [
    ...new Set([
      ...KERNEL_MODELS.map((model) => model.id),
      ...LEGACY_KERNEL_MODEL_IDS,
    ]),
  ];

  const anthropicModels: AiModelDescriptorView[] = modelIds.map((id) => {
    const option = resolveKernelModelOption(id);
    const eligibleAccessSourceIds = [
      ...(matrixIncludedModelIds.has(id)
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
    ...MANAGED_WORKERS_AI_MODELS.map((model): AiModelDescriptorView => ({
      id: model.id, vendor: "cloudflare", displayName: model.displayName,
      status: retiredManagedWorkersAiModel(model.id) ? "retired" : "current",
      capabilities: ["tools", ...(model.reasoning ? ["reasoning" as const] : []),
        ...(model.vision ? ["vision" as const] : []), "long_context"],
      // Managed harnesses do not expose per-model effort controls yet.
      effortControls: [], eligibleAccessSourceIds: ["matrix_cloudflare"],
      dataPolicies: [{ accessSourceId: "matrix_cloudflare", route: "matrix_relay", disclosureKey: "matrix-cloudflare-workers-ai" }],
      aliases: [], catalogVersion: AI_PROVIDER_CATALOG_VERSION,
    })),
    ...anthropicModels,
    ...bedrockModels(effectiveBedrockModelIds),
    ...FUNDED_PREVIEW_CHAT_ROUTES.map(({ modelId, sourceId, vendor, displayName, disclosureKey }): AiModelDescriptorView => ({
      id: modelId,
      vendor,
      displayName,
      status: "preview",
      capabilities: ["tools", "reasoning", "long_context"],
      effortControls: [],
      eligibleAccessSourceIds: [sourceId],
      dataPolicies: [{ accessSourceId: sourceId, route: "matrix_relay", disclosureKey }],
      aliases: [],
      catalogVersion: AI_PROVIDER_CATALOG_VERSION,
    })),
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

const BEDROCK_MODELS = [
  { id: "bedrock/amazon.nova-pro-v1:0", displayName: "Nova Pro" },
  { id: MATRIX_PI_BEDROCK_GPT_OSS_120B_ID, displayName: "GPT-OSS 120B" },
  { id: "bedrock/nvidia.nemotron-super-3-120b", displayName: "Nemotron 3 Super 120B" },
  { id: "bedrock/qwen.qwen3-next-80b-a3b", displayName: "Qwen3 Next 80B" },
] as const;

function bedrockModels(effectiveBedrockModelIds: ReadonlySet<string>): AiModelDescriptorView[] {
  return BEDROCK_MODELS.filter(model => effectiveBedrockModelIds.has(model.id)).map(model => ({
    ...model, vendor: "amazon", status: "preview",
    capabilities: model.id === MATRIX_PI_BEDROCK_GPT_OSS_120B_ID ? ["tools"] : ["tools", "long_context"], effortControls: [],
    eligibleAccessSourceIds: [MATRIX_BEDROCK_SOURCE_ID],
    dataPolicies: [{ accessSourceId: MATRIX_BEDROCK_SOURCE_ID, route: "matrix_relay", disclosureKey: "matrix-aws-bedrock" }],
    aliases: [], catalogVersion: AI_PROVIDER_CATALOG_VERSION,
  }));
}

export function eligibleModelsForSource(
  sourceId: string,
  catalog: readonly AiModelDescriptorView[],
): AiModelDescriptorView[] {
  return catalog.filter((model) => model.status !== "retired" && model.eligibleAccessSourceIds.includes(sourceId));
}
