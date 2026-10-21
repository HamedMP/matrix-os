import { createHash } from "node:crypto";
import { z } from "zod/v4";
import { validateBotImageInferenceBody, type BotModelRoute } from "@matrix-os/contracts";
import { SCOPE_RUNTIME_BOT_HARNESS_VERSION } from "@matrix-os/scope-runtime/bot-profile";
import type { PiRuntimeBinding } from "../../bots/runtime-registry.js";

/** Observed transport facts, not provider-account or contractual claims. Managed
 * relay/downstream evidence must be supplied by external server composition. */
export interface GoogleInferenceIdentity {
  endpoint: string;
  api: BotModelRoute["api"];
  modelId: string;
  harnessVersion: string;
  credential: { kind: "api_key" | "auth_token"; fingerprint: string; generation: string | null };
}
export type GoogleInferenceDecision = { allowed: false } | { allowed: true; googleOrigin: boolean };
export interface GoogleDataInferenceAuthority {
  authorize(input: { phase: "dispatch" | "release"; binding: PiRuntimeBinding;
    identity: GoogleInferenceIdentity | null; signal: AbortSignal }): Promise<GoogleInferenceDecision>;
}
export class GoogleInferencePolicyError extends Error {
  constructor() { super("Inference unavailable"); this.name = "GoogleInferencePolicyError"; }
}

/** Never expose the input credential or emit it in policy diagnostics. A local
 * generation is an opaque credential reference, not a verified vendor account. */
export function googleInferenceIdentity(binding: PiRuntimeBinding, endpoint: string,
  credential: { kind: "api_key" | "auth_token"; value: string }): GoogleInferenceIdentity {
  const url = new URL(endpoint);
  if (!credential.value || endpoint.includes(credential.value) || endpoint.includes(encodeURIComponent(credential.value))
    || url.username || url.password || url.hash || url.protocol !== "https:"
    || url.search !== "" && url.search !== "?beta=true") throw new GoogleInferencePolicyError();
  return { endpoint: url.toString(), api: binding.route.api, modelId: binding.route.modelId,
    harnessVersion: SCOPE_RUNTIME_BOT_HARNESS_VERSION, credential: { kind: credential.kind,
      fingerprint: createHash("sha256").update(credential.value).digest("hex"),
      generation: binding.anthropicApi?.credentialGeneration ?? null } };
}

/** A configured authority is consulted even for unresolved delegated transports.
 * Only the server authority classifies provenance. Unknown Google transports deny. */
export async function authorizeGoogleInference(authority: GoogleDataInferenceAuthority | undefined,
  input: Parameters<GoogleDataInferenceAuthority["authorize"]>[0]): Promise<GoogleInferenceDecision> {
  if (!authority) return { allowed: true, googleOrigin: false };
  try {
    const result = await authority.authorize(input);
    if (input.signal.aborted || result.allowed !== true || typeof result.googleOrigin !== "boolean"
      || result.googleOrigin && input.identity === null) return { allowed: false };
    return result;
  } catch (error: unknown) {
    console.warn("[google-data] Inference policy unavailable:", error instanceof Error ? error.name : "UnknownError");
    return { allowed: false };
  }
}

const Text = z.string();
const Name = z.string().min(1).max(256);
const TextBlock = z.strictObject({ type: z.literal("text"), text: Text });
// The pinned SDK emits these known cache directives by default. Disable them
// only at typed configuration positions, preserving tool arguments as data.
const disabledCache = { cache_control: z.strictObject({ type: z.literal('ephemeral'),
  ttl: z.enum(['5m', '1h']).optional() }).optional().transform(() => undefined) };
const AnthropicTextBlock = TextBlock.extend(disabledCache);
const Base64Image = z.strictObject({ type: z.literal("image"), source: z.strictObject({ type: z.literal("base64"),
  media_type: z.enum(["image/png", "image/jpeg", "image/webp"]), data: z.string() }) });
const InlineUrl = z.string().regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/);
const Detail = z.enum(["auto", "high", "low"]).optional();
const CompletionImage = z.strictObject({ type: z.literal("image_url"), image_url: z.strictObject({ url: InlineUrl, detail: Detail }) });
const AnthropicContent = z.union([AnthropicTextBlock, Base64Image.extend(disabledCache),
  z.strictObject({ type: z.literal("tool_use"), id: Name, name: Name, input: z.record(z.string(), z.unknown()), ...disabledCache }),
  z.strictObject({ type: z.literal("tool_result"), tool_use_id: Name,
    content: z.union([Text, z.array(z.union([AnthropicTextBlock, Base64Image.extend(disabledCache)])).max(256)]), is_error: z.boolean().optional(), ...disabledCache }),
  z.strictObject({ type: z.literal("thinking"), thinking: Text, signature: Text, ...disabledCache }),
]);
const AnthropicMessage = z.strictObject({ role: z.enum(["user", "assistant"]), content: z.union([Text, z.array(AnthropicContent).max(256)]) });

/** Walk JSON-schema configuration only. Model text, function arguments/results,
 * enum/default/example values remain ordinary data and are never scanned. */
function localSchema(value: unknown, depth = 0): boolean {
  if (depth > 24) return false;
  if (typeof value === "boolean") return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const schema = value as Record<string, unknown>;
  for (const reference of [schema.$ref, schema.$dynamicRef, schema.$recursiveRef]) {
    if (reference !== undefined && (typeof reference !== "string" || !reference.startsWith("#"))) return false;
  }
  if (schema.$id !== undefined) return false;
  for (const key of ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]) {
    const children = schema[key];
    if (children !== undefined && (!children || typeof children !== "object" || Array.isArray(children)
      || !Object.values(children).every(child => localSchema(child, depth + 1)))) return false;
  }
  for (const key of ["items", "additionalProperties", "unevaluatedProperties", "contains", "not", "if", "then", "else", "propertyNames"]) {
    if (schema[key] !== undefined && !localSchema(schema[key], depth + 1)) return false;
  }
  for (const key of ["prefixItems", "allOf", "anyOf", "oneOf"]) {
    if (schema[key] !== undefined && (!Array.isArray(schema[key]) || !schema[key].every(child => localSchema(child, depth + 1)))) return false;
  }
  return true;
}
const JsonSchema = z.record(z.string(), z.unknown()).refine(value => localSchema(value));
const AnthropicTool = z.strictObject({ name: Name, description: Text.optional(), input_schema: JsonSchema,
  eager_input_streaming: z.boolean().optional(), ...disabledCache });
const FunctionDefinition = z.strictObject({ name: Name, description: Text.optional(), parameters: JsonSchema, strict: z.boolean().optional() });
const FunctionCall = z.strictObject({ id: Name, type: z.literal("function"), function: z.strictObject({ name: Name, arguments: Text }) });
const CompletionMessage = z.union([
  z.strictObject({ role: z.enum(["system", "developer", "user"]), content: z.union([Text, z.array(z.union([TextBlock, CompletionImage])).max(256)]), name: Name.optional() }),
  z.strictObject({ role: z.literal("assistant"), content: z.union([Text, z.array(TextBlock).max(256), z.null()]).optional(),
    tool_calls: z.array(FunctionCall).max(64).optional(), reasoning_content: Text.optional(), name: Name.optional() }),
  z.strictObject({ role: z.literal("tool"), tool_call_id: Name, content: Text }),
]);
const Sampling = { temperature: z.number().min(0).max(2).optional(), top_p: z.number().min(0).max(1).optional() };
const ToolChoice = z.union([z.enum(["none", "auto", "required"]), z.strictObject({ type: z.literal("function"), function: z.strictObject({ name: Name }) })]);
const Anthropic = z.strictObject({ model: Name, stream: z.literal(true), max_tokens: z.number().int().positive(),
  messages: z.array(AnthropicMessage).min(1).max(4096), system: z.union([Text, z.array(AnthropicTextBlock).max(256)]).optional(),
  tools: z.array(AnthropicTool).max(64).optional(), tool_choice: z.union([
    z.strictObject({ type: z.enum(["auto", "any", "none"]), disable_parallel_tool_use: z.boolean().optional() }),
    z.strictObject({ type: z.literal("tool"), name: Name, disable_parallel_tool_use: z.boolean().optional() }),
  ]).optional(), thinking: z.union([z.strictObject({ type: z.literal("disabled") }),
    z.strictObject({ type: z.literal("enabled"), budget_tokens: z.number().int().positive() }), z.strictObject({ type: z.literal("adaptive") })]).optional(),
  output_config: z.strictObject({ effort: z.enum(["low", "medium", "high", "max"]).optional(),
    format: z.strictObject({ type: z.literal("json_schema"), schema: JsonSchema }).optional() }).optional(),
  stop_sequences: z.array(Text).max(16).optional(), top_k: z.number().int().nonnegative().optional(), ...Sampling,
});
const Completions = z.strictObject({ model: Name, stream: z.literal(true), messages: z.array(CompletionMessage).min(1).max(4096),
  max_tokens: z.number().int().positive().optional(), max_completion_tokens: z.number().int().positive().optional(), store: z.literal(false).optional(),
  tools: z.array(z.strictObject({ type: z.literal("function"), function: FunctionDefinition })).max(64).optional(), tool_choice: ToolChoice.optional(),
  parallel_tool_calls: z.boolean().optional(), stream_options: z.strictObject({ include_usage: z.boolean() }).optional(),
  reasoning_effort: z.enum(["none", "low", "medium", "high", "xhigh", "max"]).optional(),
  response_format: z.union([z.strictObject({ type: z.enum(["text", "json_object"]) }),
    z.strictObject({ type: z.literal("json_schema"), json_schema: z.strictObject({ name: Name, schema: JsonSchema, strict: z.boolean().optional(), description: Text.optional() }) })]).optional(),
  stop: z.union([Text, z.array(Text).max(16)]).optional(), seed: z.number().int().optional(), n: z.literal(1).optional(),
  frequency_penalty: z.number().min(-2).max(2).optional(), presence_penalty: z.number().min(-2).max(2).optional(), ...Sampling,
});
const ResponseText = z.strictObject({ type: z.literal("input_text"), text: Text });
const ResponseInput = z.union([
  z.strictObject({ role: z.enum(["system", "developer", "user", "assistant"]), type: z.literal("message").optional(),
    content: z.union([Text, z.array(z.union([ResponseText, z.strictObject({ type: z.literal("output_text"), text: Text }),
      z.strictObject({ type: z.literal("input_image"), image_url: InlineUrl, detail: Detail })])).max(256)]) }),
  z.strictObject({ type: z.literal("function_call"), call_id: Name, name: Name, arguments: Text }),
  z.strictObject({ type: z.literal("function_call_output"), call_id: Name, output: Text }),
]);
const Responses = z.strictObject({ model: Name, stream: z.literal(true), store: z.literal(false).optional(),
  input: z.union([Text, z.array(ResponseInput).min(1).max(4096)]), instructions: Text.optional(),
  tools: z.array(FunctionDefinition.extend({ type: z.literal("function") })).max(64).optional(),
  tool_choice: z.union([z.enum(["none", "auto", "required"]), z.strictObject({ type: z.literal("function"), name: Name })]).optional(),
  parallel_tool_calls: z.boolean().optional(), max_output_tokens: z.number().int().positive().optional(),
  reasoning: z.strictObject({ effort: z.enum(["none", "low", "medium", "high", "xhigh", "max"]) }).optional(), ...Sampling,
});

/** A deliberately narrow stateless wire contract. Unsupported controls deny,
 * rather than silently stripping hosted tools, persistence or remote references. */
export function prepareGoogleInferenceBody(api: BotModelRoute["api"], body: string): string {
  try {
    if (!validateBotImageInferenceBody(body).valid) throw new GoogleInferencePolicyError();
    const value: unknown = JSON.parse(body);
    if (api === "anthropic-messages") return JSON.stringify(Anthropic.parse(value));
    if (api === "openai-completions") return JSON.stringify({ ...Completions.parse(value), store: false });
    if (api === "openai-responses") return JSON.stringify({ ...Responses.parse(value), store: false });
    throw new GoogleInferencePolicyError();
  } catch (error: unknown) {
    if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof GoogleInferencePolicyError) throw new GoogleInferencePolicyError();
    throw error;
  }
}

/** Beta headers are typed API configuration too; do not let a cache or unknown
 * experiment bypass the body contract. Never inspect model text for these keys. */
export function googleInferenceHeadersAllowed(headers: Record<string, string>): boolean {
  const allowedBetas = new Set(["interleaved-thinking-2025-05-14", "fine-grained-tool-streaming-2025-05-14", "context-1m-2025-08-07"]);
  return Object.entries(headers).every(([key, value]) => key.toLowerCase() === "anthropic-version" ? value === "2023-06-01"
    : key.toLowerCase() === "anthropic-beta" && value.split(",").every(beta => allowedBetas.has(beta.trim())));
}
