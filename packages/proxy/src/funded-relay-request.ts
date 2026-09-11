import { z } from "zod/v4";
import { BETA_ID } from "./funded-relay-config.js";

const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

const MAX_JSON_DEPTH = 16;
const MAX_JSON_ARRAY_ITEMS = 2_048;
const MAX_JSON_OBJECT_KEYS = 256;
const MAX_JSON_KEY_LENGTH = 128;
const MAX_JSON_STRING_LENGTH = 1024 * 1024;

function validateBoundedJson(value: unknown, ctx: z.RefinementCtx, depth: number): void {
  if (depth > MAX_JSON_DEPTH) {
    ctx.addIssue({ code: "custom", message: "JSON nesting is too deep" });
    return;
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) ctx.addIssue({ code: "custom", message: "JSON number must be finite" });
    return;
  }
  if (typeof value === "string") {
    if (value.length > MAX_JSON_STRING_LENGTH) {
      ctx.addIssue({ code: "custom", message: "JSON string is too long" });
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_JSON_ARRAY_ITEMS) {
      ctx.addIssue({ code: "custom", message: "JSON array has too many items" });
      return;
    }
    for (const item of value) validateBoundedJson(item, ctx, depth + 1);
    return;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length > MAX_JSON_OBJECT_KEYS) {
      ctx.addIssue({ code: "custom", message: "JSON object has too many keys" });
      return;
    }
    for (const [key, item] of entries) {
      if (key.length > MAX_JSON_KEY_LENGTH) {
        ctx.addIssue({ code: "custom", message: "JSON object key is too long" });
        continue;
      }
      validateBoundedJson(item, ctx, depth + 1);
    }
    return;
  }
  ctx.addIssue({ code: "custom", message: "Unsupported JSON value" });
}

const BoundedJsonSchema = z.unknown().superRefine((value, ctx) => {
  validateBoundedJson(value, ctx, 0);
});

const MessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.union([
    z.string().max(MAX_JSON_STRING_LENGTH),
    z.array(BoundedJsonSchema).max(1_024),
  ]),
}).strict();

const ToolSchema = z.object({
  name: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/),
  description: z.string().max(32_768).optional(),
  input_schema: BoundedJsonSchema,
  cache_control: BoundedJsonSchema.optional(),
}).strict();

const ToolChoiceSchema = z.union([
  z.object({
    type: z.literal("auto"),
    disable_parallel_tool_use: z.boolean().optional(),
  }).strict(),
  z.object({
    type: z.literal("any"),
    disable_parallel_tool_use: z.boolean().optional(),
  }).strict(),
  z.object({
    type: z.literal("tool"),
    name: z.string().min(1).max(128),
    disable_parallel_tool_use: z.boolean().optional(),
  }).strict(),
  z.object({ type: z.literal("none") }).strict(),
]);

const ThinkingSchema = z.union([
  z.object({ type: z.literal("disabled") }).strict(),
  z.object({
    type: z.literal("enabled"),
    budget_tokens: z.number().int().positive().max(128_000),
  }).strict(),
  z.object({ type: z.literal("adaptive") }).strict(),
]);

export const FundedRequestSchema = z.object({
  model: z.string().regex(MODEL_ID),
  max_tokens: z.number().int().positive().max(128_000).optional(),
  stream: z.boolean().optional(),
  messages: z.array(MessageSchema).min(1).max(1_024),
  system: z.union([
    z.string().max(MAX_JSON_STRING_LENGTH),
    z.array(BoundedJsonSchema).max(256),
  ]).optional(),
  tools: z.array(ToolSchema).max(256).optional(),
  tool_choice: ToolChoiceSchema.optional(),
  metadata: z.object({ user_id: z.string().min(1).max(256) }).strict().optional(),
  stop_sequences: z.array(z.string().max(1_024)).max(64).optional(),
  temperature: z.number().min(0).max(1).optional(),
  top_k: z.number().int().min(0).max(500).optional(),
  top_p: z.number().min(0).max(1).optional(),
  thinking: ThinkingSchema.optional(),
  output_config: z.object({
    effort: z.enum(["low", "medium", "high", "max"]).optional(),
    format: BoundedJsonSchema.optional(),
  }).strict().optional(),
}).strict();

export type FundedRequest = z.infer<typeof FundedRequestSchema>;

export function serializeFundedRequest(value: unknown): { body: string; request: FundedRequest } {
  const request = FundedRequestSchema.parse(value);
  const { metadata: _callerMetadata, ...forwarded } = request;
  return { body: JSON.stringify(forwarded), request };
}

export function serializeCountTokensRequest(request: FundedRequest): string {
  return JSON.stringify({
    model: request.model,
    messages: request.messages,
    ...(request.system === undefined ? {} : { system: request.system }),
    ...(request.tools === undefined ? {} : { tools: request.tools }),
    ...(request.tool_choice === undefined ? {} : { tool_choice: request.tool_choice }),
    ...(request.thinking === undefined ? {} : { thinking: request.thinking }),
  });
}

export function resolveRequestedBetas(
  header: string | undefined,
  allowedBetas: ReadonlySet<string>,
): string | null {
  if (!header) return null;
  if (header.length > 1_024) throw new Error("Anthropic beta header is too long");
  const requested = [...new Set(header.split(",").map((entry) => entry.trim()).filter(Boolean))];
  if (
    requested.length === 0
    || requested.length > 16
    || requested.some((beta) => !BETA_ID.test(beta) || !allowedBetas.has(beta))
  ) {
    throw new Error("Anthropic beta header contains an unsupported value");
  }
  return requested.join(",");
}
