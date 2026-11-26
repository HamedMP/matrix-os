export const FREE_MANAGED_MODEL_ID = "@cf/zai-org/glm-5.3-flash";

/** Exact managed Workers AI routes reviewed against the Cloudflare catalog.
 * Keep the inexpensive existing default first. Only models with verified
 * inline image support advertise vision.
 */
export const LEGACY_MANAGED_WORKERS_AI_MODEL_IDS = [
  FREE_MANAGED_MODEL_ID,
  "@cf/deepseek-ai/deepseek-v4-flash-0731",
  "@cf/zai-org/glm-5.3",
  "@cf/moonshotai/kimi-k2.7-code",
  "@cf/openai/gpt-oss-120b",
  "@cf/google/gemma-4-26b-a4b-it",
  "@cf/deepseek-ai/deepseek-v4-pro-0813",
  "@cf/qwen/qwen3.8-27b",
  "@cf/openai/gpt-oss-20b",
] as const;
/** Ordinary runtime entitlement and legacy execution policy. */
export const MANAGED_WORKERS_AI_MODEL_IDS = [
  ...LEGACY_MANAGED_WORKERS_AI_MODEL_IDS,
  "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
] as const;
export const INKLING_2_SMALL_MODEL_ID = "@cf/thinkingmachines/inkling-2-small" as const;
// Route metadata also covers Workers models that need a separate Preview binding.
const CONFIGURED_WORKERS_AI_MODEL_IDS = [...MANAGED_WORKERS_AI_MODEL_IDS, INKLING_2_SMALL_MODEL_ID] as const;
export type ManagedWorkersAiModelId = typeof CONFIGURED_WORKERS_AI_MODEL_IDS[number];
// Cloudflare stopped serving these managed routes on November 20, 2026.
const RETIRED_MANAGED_WORKERS_AI_MODEL_IDS: readonly ManagedWorkersAiModelId[] = [
  "@cf/zai-org/glm-5.3-flash",
  "@cf/deepseek-ai/deepseek-v4-flash-0731",
  "@cf/deepseek-ai/deepseek-v4-pro-0813",
  "@cf/moonshotai/kimi-k2.7-code",
];

export interface ManagedWorkersAiModel {
  readonly id: ManagedWorkersAiModelId;
  readonly displayName: string;
  readonly maximumInputTokens: number;
  readonly reasoningEfforts: readonly string[];
  readonly reasoning: boolean;
  readonly vision: boolean;
  readonly outputTokenField: "max_tokens" | "max_completion_tokens";
}
const definitions = [
  ["GLM 5.3 Flash", 1_310_720, ["low", "high", "max"], "max_tokens"],
  ["DeepSeek V4 Flash 0731", 1_048_576, ["none", "low", "high", "max"], "max_tokens"],
  ["GLM 5.3", 1_048_576, ["low", "high", "max"], "max_tokens"],
  ["Kimi K2.7 Code", 262_144, [], "max_tokens"],
  ["GPT-OSS 120B", 128_000, ["low", "medium", "high"], "max_tokens"],
  ["Gemma 4 26B A4B", 256_000, [], "max_tokens"],
  ["DeepSeek V4 Pro 0813", 1_048_576, ["none", "low", "high", "max"], "max_tokens"],
  ["Qwen 3.8 27B", 262_144, ["low", "medium", "xhigh"], "max_completion_tokens"],
  ["GPT-OSS 20B", 128_000, ["low", "medium", "high"], "max_tokens"],
  ["DeepSeek V4.1 Flash", 1_048_576, ["none", "low", "high", "max"], "max_completion_tokens", true],
  ["Inkling 2 Small", 1_048_576, ["none", "low", "medium", "high", "max"], "max_completion_tokens"],
] as const;
export const MANAGED_WORKERS_AI_MODELS: readonly Readonly<ManagedWorkersAiModel>[] = Object.freeze(
  CONFIGURED_WORKERS_AI_MODEL_IDS.map((id, index) => {
    const [displayName, maximumInputTokens, reasoningEfforts, outputTokenField, vision = false] = definitions[index]!;
    return Object.freeze({ id, displayName, maximumInputTokens, reasoning: true,
      reasoningEfforts: Object.freeze([...reasoningEfforts]), outputTokenField, vision });
  }),
);
export function isManagedWorkersAiModel(id: string): id is ManagedWorkersAiModelId {
  return (CONFIGURED_WORKERS_AI_MODEL_IDS as readonly string[]).includes(id);
}
export function managedWorkersAiModel(id: string): Readonly<ManagedWorkersAiModel> | undefined {
  return MANAGED_WORKERS_AI_MODELS.find(model => model.id === id);
}

/** Resolve a retired model's metadata for the catalog and previously saved selections. */
export function retiredManagedWorkersAiModel(reference: string): Readonly<ManagedWorkersAiModel> | undefined {
  // Older Chat and Bot selections included the Cloudflare provider prefix.
  const model = managedWorkersAiModel(reference.replace(/^cloudflare:/, ""));
  return model && RETIRED_MANAGED_WORKERS_AI_MODEL_IDS.includes(model.id) ? model : undefined;
}

/** Cloudflare currently emits this one internal Gemma ID on its model-in-path
 * endpoint. Accept only the observed exact pair, never a generic suffix match. */
export function isManagedWorkersAiResponseModel(requested: string, actual: unknown): boolean {
  if (!isManagedWorkersAiModel(requested)) return false;
  return actual === requested || (requested === "@cf/google/gemma-4-26b-a4b-it"
    && actual === "@cf/google/gemma-4-26b-a4b-it-external");
}
