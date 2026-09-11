import { z } from "zod/v4";
import { FUNDED_GLM_FLASH } from "./funded-relay-model.js";
import { BoundedJsonSchema } from "./funded-relay-request.js";

const Text = z.string().max(1024 * 1024);
const Name = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const ToolCall = z.object({
  id: z.string().min(1).max(256), type: z.literal("function"),
  function: z.object({ name: Name, arguments: Text }).strict(),
}).strict();
// Remote images/audio and server-side tools are deliberately not accepted:
// these routes have unreviewed fetching and charging semantics.
const Content = z.union([Text, z.array(z.object({ type: z.literal("text"), text: Text }).strict()).max(1024)]);
const Message = z.discriminatedUnion("role", [
  z.object({ role: z.enum(["system", "developer", "user"]), content: Content }).strict(),
  z.object({ role: z.literal("assistant"), content: Content.nullable().optional(),
    reasoning_content: Text.nullable().optional(), tool_calls: z.array(ToolCall).max(256).optional(),
  }).strict(),
  z.object({ role: z.literal("tool"), content: Content, tool_call_id: z.string().min(1).max(256) }).strict(),
]);
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
  reasoning_effort: z.enum(["low", "medium", "high"]).optional(),
  temperature: z.number().min(0).max(2).optional(), top_p: z.number().min(0).max(1).optional(),
  frequency_penalty: z.number().min(-2).max(2).optional(), presence_penalty: z.number().min(-2).max(2).optional(),
  stop: z.union([z.string().max(1024), z.array(z.string().max(1024)).max(4)]).optional(),
  seed: z.number().int().safe().optional(), n: z.literal(1).optional(), store: z.literal(false).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.max_tokens !== undefined && value.max_completion_tokens !== undefined) {
    ctx.addIssue({ code: "custom", message: "Only one output bound is allowed" });
  }
});

export function serializeFundedOpenAiRequest(value: unknown) {
  const parsed = RequestSchema.parse(value);
  if (parsed.model !== FUNDED_GLM_FLASH) throw new Error("Unsupported funded AI model");
  // A client without an output limit still receives a bounded generation.
  const maxTokens = parsed.max_completion_tokens ?? parsed.max_tokens ?? 8192;
  const request = { ...parsed, max_tokens: maxTokens };
  const { max_tokens: _max, max_completion_tokens: _maxCompletion, ...rest } = parsed;
  return { request, body: JSON.stringify({ ...rest, max_tokens: maxTokens,
    ...(parsed.stream ? { stream_options: { include_usage: true } } : {}), store: false }) };
}

/** Both account and gateway come from the validated operator configuration,
 * never from a caller URL/header. This is the prepaid Workers AI route.
 * https://developers.cloudflare.com/ai-gateway/usage/rest-api/#call-a-workers-ai-model
 */
export function workersAiTarget(gatewayBaseUrl: string): { url: string; gatewayId: string } {
  const parts = new URL(gatewayBaseUrl).pathname.split("/");
  const accountId = parts[2];
  const gatewayId = parts[3];
  if (!/^[a-f0-9]{32}$/.test(accountId ?? "") || !/^[a-zA-Z0-9_-]{1,64}$/.test(gatewayId ?? "")) {
    throw new Error("Invalid Workers AI gateway configuration");
  }
  return { url: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${FUNDED_GLM_FLASH}`, gatewayId: gatewayId! };
}
