/** Exact managed Workers AI routes reviewed against the Cloudflare catalog.
 * Keep the inexpensive existing default first. Text/tools only: image fetching
 * and provider-owned tools need separate funding/security review.
 */
export const MANAGED_WORKERS_AI_MODEL_IDS = [
  "@cf/zai-org/glm-5.3-flash",
  "@cf/deepseek-ai/deepseek-v4-flash-0731",
  "@cf/zai-org/glm-5.3",
  "@cf/moonshotai/kimi-k2.7-code",
  "@cf/openai/gpt-oss-120b",
  "@cf/google/gemma-4-26b-a4b-it",
  "@cf/deepseek-ai/deepseek-v4-pro-0813",
  "@cf/qwen/qwen3.8-27b",
  "@cf/openai/gpt-oss-20b",
] as const;
export type ManagedWorkersAiModelId = typeof MANAGED_WORKERS_AI_MODEL_IDS[number];
export interface ManagedWorkersAiModel {
  readonly id: ManagedWorkersAiModelId;
  readonly displayName: string;
  readonly maximumInputTokens: number;
  readonly reasoningEfforts: readonly string[];
  readonly reasoning: boolean;
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
] as const;
export const MANAGED_WORKERS_AI_MODELS: readonly Readonly<ManagedWorkersAiModel>[] = Object.freeze(
  MANAGED_WORKERS_AI_MODEL_IDS.map((id, index) => {
    const [displayName, maximumInputTokens, reasoningEfforts, outputTokenField] = definitions[index]!;
    return Object.freeze({ id, displayName, maximumInputTokens, reasoning: true,
      reasoningEfforts: Object.freeze([...reasoningEfforts]), outputTokenField });
  }),
);
export function isManagedWorkersAiModel(id: string): id is ManagedWorkersAiModelId {
  return (MANAGED_WORKERS_AI_MODEL_IDS as readonly string[]).includes(id);
}
export function managedWorkersAiModel(id: string): Readonly<ManagedWorkersAiModel> | undefined {
  return MANAGED_WORKERS_AI_MODELS.find(model => model.id === id);
}

/** Cloudflare currently emits this one internal Gemma ID on its model-in-path
 * endpoint. Accept only the observed exact pair, never a generic suffix match. */
export function isManagedWorkersAiResponseModel(requested: string, actual: unknown): boolean {
  if (!isManagedWorkersAiModel(requested)) return false;
  return actual === requested || (requested === "@cf/google/gemma-4-26b-a4b-it"
    && actual === "@cf/google/gemma-4-26b-a4b-it-external");
}
