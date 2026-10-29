import { z } from "zod/v4";
import {
  ALIBABA_QWEN_37_PLUS_MODEL_ID,
  ALIBABA_QWEN_37_PLUS_PREVIEW_MAX_OUTPUT_TOKENS,
  BOT_FUNDED_IMAGE_TOTAL_MAX_BYTES,
  BOT_INFERENCE_TEXT_MAX_BYTES,
  GOOGLE_GEMINI_38_FLASH_MODEL_ID,
  GOOGLE_GEMINI_38_FLASH_PREVIEW_MAX_OUTPUT_TOKENS,
  MANAGED_WORKERS_AI_MODEL_IDS,
  MOONSHOT_KIMI_K31_PRO_MODEL_ID,
  MOONSHOT_KIMI_K31_PRO_PREVIEW_MAX_OUTPUT_TOKENS,
  managedWorkersAiModel,
  validateBotImageInferenceBody,
} from "@matrix-os/contracts";
import { FundedGeminiReplaySchema, restoreFundedGeminiToolSignatures } from "./funded-relay-openai-response.js";
import { BoundedJsonSchema } from "./funded-relay-request.js";

const Text = z.string().max(1024 * 1024);
const Name = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const ToolCall = z.object({
  id: z.string().min(1).max(256), type: z.literal("function"),
  function: z.object({ name: Name, arguments: Text }).strict(),
}).strict();
const TextPart = z.object({ type: z.literal("text"), text: Text }).strict();
const ImagePart = z.object({ type: z.literal("image_url"), image_url: z.object({
  url: z.string().max(Math.ceil(BOT_FUNDED_IMAGE_TOTAL_MAX_BYTES / 3) * 4 + 64),
  detail: z.enum(["auto", "high", "low"]).optional(),
}).strict() }).strict();
const Content = z.union([Text, z.array(TextPart).max(1024)]);
const UserContent = z.union([Text, z.array(z.discriminatedUnion("type", [TextPart, ImagePart])).max(1024)]);
const SystemMessage = z.object({ role: z.enum(["system", "developer"]), content: Content }).strict();
const UserMessage = z.object({ role: z.literal("user"), content: UserContent }).strict();
const AssistantMessage = z.object({ role: z.literal("assistant"), content: Content.nullable().optional(),
  reasoning_content: Text.nullable().optional(), tool_calls: z.array(ToolCall).max(256).optional() }).strict();
const ToolMessage = z.object({ role: z.literal("tool"), content: Content, tool_call_id: z.string().min(1).max(256) }).strict();
const Message = z.discriminatedUnion("role", [SystemMessage, UserMessage, AssistantMessage, ToolMessage]);
const GeminiMessage = z.discriminatedUnion("role", [SystemMessage, UserMessage, AssistantMessage.extend({
  reasoning_details: z.array(FundedGeminiReplaySchema).max(256).optional(),
}), ToolMessage]);
const MaxTokens = z.number().int().positive().max(128_000);
const RequestSchema = z.object({
  model: z.string().min(1).max(256), messages: z.array(Message).min(1).max(1024),
  max_tokens: MaxTokens.optional(), max_completion_tokens: MaxTokens.optional(),
  stream: z.boolean().optional(),
  stream_options: z.object({ include_usage: z.boolean().optional() }).strict().optional(),
  tools: z.array(z.object({ type: z.literal("function"), function: z.object({
    name: Name, description: z.string().max(32_768).optional(),
    parameters: BoundedJsonSchema, strict: z.boolean().optional(),
  }).strict() }).strict()).max(256).optional(),
  tool_choice: z.union([z.enum(["auto", "none", "required"]), z.object({
    type: z.literal("function"), function: z.object({ name: Name }).strict(),
  }).strict()]).optional(),
  parallel_tool_calls: z.boolean().optional(),
  // The selected model validates its own supported effort levels below.
  reasoning_effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  temperature: z.number().min(0).max(2).optional(), top_p: z.number().min(0).max(1).optional(),
  frequency_penalty: z.number().min(-2).max(2).optional(), presence_penalty: z.number().min(-2).max(2).optional(),
  stop: z.union([z.string().max(1024), z.array(z.string().max(1024)).max(4)]).optional(),
  seed: z.number().int().safe().optional(), n: z.literal(1).optional(), store: z.literal(false).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.max_tokens !== undefined && value.max_completion_tokens !== undefined) {
    ctx.addIssue({ code: "custom", message: "Only one output bound is allowed" });
  }
});

const GeminiRequestSchema = RequestSchema.safeExtend({
  model: z.literal(GOOGLE_GEMINI_38_FLASH_MODEL_ID),
  messages: z.array(GeminiMessage).min(1).max(1024),
  reasoning_effort: z.enum(["low", "medium", "high"]).optional(),
});

const KimiRequestSchema = RequestSchema.safeExtend({
  model: z.literal(MOONSHOT_KIMI_K31_PRO_MODEL_ID),
  reasoning_effort: z.enum(["low", "high", "max"]).optional(),
});

const ObjectToolParameters = z.looseObject({ type: z.literal("object") });
const ObjectToolParameterUnion = z.looseObject({
  type: z.never().optional(),
  oneOf: z.array(ObjectToolParameters).nonempty(),
});

function previewObjectToolParameters(parameters: unknown): unknown {
  if (ObjectToolParameters.safeParse(parameters).success) return parameters;
  const untypedUnion = ObjectToolParameterUnion.safeParse(parameters);
  if (!untypedUnion.success) throw new Error("Unsupported Cloudflare Preview tool parameter schema");
  // These Cloudflare routes accept tool objects with an explicit root type. The type is
  // already implied by every variant, so preserve the schema and annotations.
  return { ...untypedUnion.data, type: "object" };
}

function previewObjectTools(tools: z.infer<typeof RequestSchema>["tools"]) {
  return tools?.map(tool => ({ ...tool,
    function: { ...tool.function, parameters: previewObjectToolParameters(tool.function.parameters) },
  }));
}

function hasImageInput(messages: Array<z.infer<typeof Message>>): boolean {
  return messages.some(message => message.role === "user" && Array.isArray(message.content)
    && message.content.some(part => part.type === "image_url"));
}

function serializeKimiRequest(value: unknown) {
  const parsed = KimiRequestSchema.parse(value);
  const maxTokens = parsed.max_completion_tokens ?? parsed.max_tokens ?? MOONSHOT_KIMI_K31_PRO_PREVIEW_MAX_OUTPUT_TOKENS;
  if (maxTokens > MOONSHOT_KIMI_K31_PRO_PREVIEW_MAX_OUTPUT_TOKENS || hasImageInput(parsed.messages)) {
    throw new Error("Unsupported Kimi Preview request");
  }
  const { max_completion_tokens: _alternativeMax, store: _store, tools, ...rest } = parsed;
  const request = { ...rest, reasoning_effort: parsed.reasoning_effort ?? "low", max_tokens: maxTokens,
    ...(tools === undefined ? {} : { tools: previewObjectTools(tools) }) };
  return { request, body: JSON.stringify({ ...request,
    ...(parsed.stream ? { stream_options: { include_usage: true } } : {}) }) };
}

function serializeGeminiRequest(value: unknown) {
  const parsed = GeminiRequestSchema.parse(value);
  const maxTokens = parsed.max_completion_tokens ?? parsed.max_tokens ?? GOOGLE_GEMINI_38_FLASH_PREVIEW_MAX_OUTPUT_TOKENS;
  if (maxTokens > GOOGLE_GEMINI_38_FLASH_PREVIEW_MAX_OUTPUT_TOKENS) throw new Error("Invalid funded Gemini output bound");
  // The isolated transport covers text and tool calling. It does not expose media inputs.
  if (hasImageInput(parsed.messages)) throw new Error("Unsupported funded AI image input");
  const messages = parsed.messages.map(message => {
    if (message.role !== "assistant") return message;
    const { reasoning_details, reasoning_content: _reasoningContent, tool_calls, ...assistant } = message;
    if (!tool_calls && !reasoning_details?.length) return assistant;
    return { ...assistant, tool_calls: restoreFundedGeminiToolSignatures(tool_calls ?? [], reasoning_details ?? []) };
  });
  const reasoning_effort = parsed.reasoning_effort ?? "low";
  const { max_tokens: _max, max_completion_tokens: _maxCompletion, store: _store, tools, ...rest } = parsed;
  return { request: { ...parsed, reasoning_effort, max_tokens: maxTokens },
    body: JSON.stringify({ ...rest, messages, tools: previewObjectTools(tools), reasoning_effort, max_completion_tokens: maxTokens,
      ...(parsed.stream ? { stream_options: { include_usage: true } } : {}) }) };
}

function serializeQwenPlusRequest(value: unknown) {
  const parsed = RequestSchema.parse(value);
  const maxTokens = parsed.max_completion_tokens ?? parsed.max_tokens ?? ALIBABA_QWEN_37_PLUS_PREVIEW_MAX_OUTPUT_TOKENS;
  if (maxTokens > ALIBABA_QWEN_37_PLUS_PREVIEW_MAX_OUTPUT_TOKENS || hasImageInput(parsed.messages)) {
    throw new Error("Unsupported Qwen 3.7 Plus Preview request");
  }
  const { max_tokens: _max, max_completion_tokens: _maxCompletion, store: _store, ...rest } = parsed;
  return { request: { ...rest, max_tokens: maxTokens },
    body: JSON.stringify({ ...rest, max_completion_tokens: maxTokens,
      ...(parsed.stream ? { stream_options: { include_usage: true } } : {}) }) };
}

export function serializeFundedOpenAiRequest(value: unknown) {
  if (typeof value === "object" && value !== null && "model" in value) {
    if (value.model === GOOGLE_GEMINI_38_FLASH_MODEL_ID) return serializeGeminiRequest(value);
    if (value.model === ALIBABA_QWEN_37_PLUS_MODEL_ID) return serializeQwenPlusRequest(value);
    if (value.model === MOONSHOT_KIMI_K31_PRO_MODEL_ID) return serializeKimiRequest(value);
  }
  const parsed = RequestSchema.parse(value);
  const model = managedWorkersAiModel(parsed.model);
  if (!model) throw new Error("Unsupported funded AI model");
  if (parsed.reasoning_effort !== undefined && !model.reasoningEfforts.includes(parsed.reasoning_effort)) {
    throw new Error("Unsupported reasoning effort");
  }
  const reasoningEffort = parsed.reasoning_effort ?? (model.reasoningEfforts.includes("low") ? "low" : undefined);
  // A client without an output limit still receives a bounded generation.
  const maxTokens = parsed.max_completion_tokens ?? parsed.max_tokens ?? 8192;
  // GPT-OSS's published template uses a string membership guard on assistant
  // content. Empty text preserves tool-only turns that OpenAI clients encode
  // with null, without changing tools or deliberate assistant text.
  const messages = parsed.model === '@cf/openai/gpt-oss-20b' ? parsed.messages.map(message =>
    message.role === 'assistant' && message.content == null ? { ...message, content: '' } : message) : parsed.messages;
  const request = { ...parsed, messages, reasoning_effort: reasoningEffort, max_tokens: maxTokens };
  const { max_tokens: _max, max_completion_tokens: _maxCompletion, ...rest } = request;
  const body = JSON.stringify({ ...rest, [model.outputTokenField]: maxTokens,
    ...(parsed.stream ? { stream_options: { include_usage: true } } : {}), store: false });
  const hasImages = hasImageInput(parsed.messages);
  // The managed Bot validator accepts only local PNG/JPEG/WebP data URLs.
  // Match the funded Chat attachment cap before obtaining policy or credit.
  if (hasImages && (!model.vision || !validateBotImageInferenceBody(
    body, BOT_INFERENCE_TEXT_MAX_BYTES, BOT_FUNDED_IMAGE_TOTAL_MAX_BYTES,
  ).valid)) throw new Error("Unsupported funded AI image input");
  return { request, body };
}

/** Both account and gateway come from the validated operator configuration,
 * never from a caller URL/header. This is the prepaid Workers AI route.
 * https://developers.cloudflare.com/ai-gateway/usage/rest-api/#call-a-workers-ai-model
 */
export function workersAiTarget(gatewayBaseUrl: string, modelId: string = MANAGED_WORKERS_AI_MODEL_IDS[0]): { url: string; gatewayId: string } {
  if (!managedWorkersAiModel(modelId)) throw new Error("Unsupported funded AI model");
  const parts = new URL(gatewayBaseUrl).pathname.split("/");
  const accountId = parts[2];
  const gatewayId = parts[3];
  if (!/^[a-f0-9]{32}$/.test(accountId ?? "") || !/^[a-zA-Z0-9_-]{1,64}$/.test(gatewayId ?? "")) {
    throw new Error("Invalid Workers AI gateway configuration");
  }
  return { url: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${modelId}`, gatewayId: gatewayId! };
}
