import { z } from "zod/v4";
import { RuntimeHandleSchema } from "./protocol.js";

const MAX_PROVIDER_BODY_BYTES = 256 * 1024;
const MAX_BROKER_BODY_BYTES = 512 * 1024;
const RequestIdSchema = z.string().uuid();
const GenerationSchema = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);
const BoundedBodySchema = z.string().refine(
  (value) => Buffer.byteLength(value, "utf8") <= MAX_PROVIDER_BODY_BYTES,
  "Broker body exceeds limit",
);

const InferenceHeadersSchema = z.object({
  "anthropic-version": z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/).optional(),
  "anthropic-beta": z.string().min(1).max(512).regex(/^[A-Za-z0-9,._ -]+$/).optional(),
}).strict();

const InferenceRequestSchema = z.object({
  version: z.literal(1),
  action: z.literal("inference.messages"),
  requestId: RequestIdSchema,
  runtimeHandle: RuntimeHandleSchema,
  executionGeneration: GenerationSchema,
  method: z.enum(["HEAD", "POST"]),
  path: z.enum(["/api/hello", "/v1/messages?beta=true"]),
  headers: InferenceHeadersSchema,
  body: BoundedBodySchema,
}).strict().superRefine((value, context) => {
  const valid = (value.method === "HEAD" && value.path === "/api/hello" && value.body === "")
    || (value.method === "POST" && value.path === "/v1/messages?beta=true");
  if (!valid) context.addIssue({ code: "custom", message: "Invalid inference route" });
});

const CodexResponsesBodySchema = z.string().refine((body) => {
  try {
    const value: unknown = JSON.parse(body);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      && typeof (value as { model?: unknown }).model === "string"
      && /^[A-Za-z0-9._:/-]{1,256}$/.test((value as { model: string }).model)
      && (value as { stream?: unknown }).stream === true
      && Array.isArray((value as { input?: unknown }).input)
      && (!("tools" in value) || (Array.isArray((value as { tools?: unknown }).tools)
        && (value as { tools: unknown[] }).tools.length === 0));
  } catch (error: unknown) {
    if (!(error instanceof Error)) throw new Error("Invalid Codex Responses body");
    return false;
  }
}, "Invalid Codex Responses body");

const ResponsesRequestSchema = z.object({
  version: z.literal(1),
  action: z.literal("inference.responses"),
  requestId: RequestIdSchema,
  runtimeHandle: RuntimeHandleSchema,
  executionGeneration: GenerationSchema,
  method: z.literal("POST"),
  path: z.literal("/v1/responses"),
  headers: z.object({}).strict(),
  body: BoundedBodySchema.and(CodexResponsesBodySchema),
}).strict();

const EgressRequestSchema = z.object({
  version: z.literal(1),
  action: z.literal("egress.fetch"),
  requestId: RequestIdSchema,
  runtimeHandle: RuntimeHandleSchema,
  executionGeneration: GenerationSchema,
  method: z.literal("GET"),
  url: z.string().min(1).max(2_048).url(),
  accept: z.enum(["application/json", "text/plain"]),
}).strict();

export const ScopeRuntimeBrokerRequestSchema = z.union([
  InferenceRequestSchema,
  ResponsesRequestSchema,
  EgressRequestSchema,
]);

const SuccessResponseSchema = z.object({
  version: z.literal(1),
  requestId: RequestIdSchema,
  ok: z.literal(true),
  status: z.number().int().min(200).max(299),
  headers: z.object({
    "content-type": z.string().min(1).max(128).optional(),
    "cache-control": z.string().min(1).max(128).optional(),
  }).strict(),
  body: z.string().refine(
    (value) => Buffer.byteLength(value, "utf8") <= MAX_BROKER_BODY_BYTES,
    "Broker response exceeds limit",
  ),
}).strict();

const FailureResponseSchema = z.object({
  version: z.literal(1),
  requestId: RequestIdSchema,
  ok: z.literal(false),
  error: z.enum([
    "action_denied",
    "route_denied",
    "invalid_request",
    "request_too_large",
    "capacity_exceeded",
    "provider_unavailable",
    "response_too_large",
  ]),
}).strict();

export const ScopeRuntimeBrokerResponseSchema = z.union([
  SuccessResponseSchema,
  FailureResponseSchema,
]);

export type ScopeRuntimeBrokerRequest = z.infer<typeof ScopeRuntimeBrokerRequestSchema>;
export type ScopeRuntimeBrokerResponse = z.infer<typeof ScopeRuntimeBrokerResponseSchema>;
