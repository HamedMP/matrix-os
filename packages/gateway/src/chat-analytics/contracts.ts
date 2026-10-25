import { z } from "zod/v4";

export const TASK_TYPES = {
  coding: ["generate", "debug", "review", "explain", "refactor", "tests"],
  research: ["lookup", "compare", "synthesis"], writing: ["draft", "rewrite", "summarize"],
  translation: ["translate"], planning: ["plan"], data_analysis: ["analyze"],
  question_answering: ["answer"], other: ["other"],
} as const;
const families = ["coding", "research", "writing", "translation", "planning", "data_analysis", "question_answering", "other"] as const;
export const ChatAnalyticsTagsSchema = z.strictObject({
  taskFamily: z.enum(families),
  taskType: z.enum(["generate", "debug", "review", "explain", "refactor", "tests", "lookup", "compare", "synthesis", "draft", "rewrite", "summarize", "translate", "plan", "analyze", "answer", "other"]),
  complexity: z.enum(["low", "medium", "high"]),
  /** Uncalibrated model self-report, never a probability of correctness. */
  confidence: z.number().finite().min(0).max(1).optional(),
}).refine(value => (TASK_TYPES[value.taskFamily] as readonly string[]).includes(value.taskType));
export type ChatAnalyticsTags = z.infer<typeof ChatAnalyticsTagsSchema>;
const reference = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/);
export const GenerationBindingSchema = z.strictObject({ ownerId: reference, chatId: reference, runId: reference,
  runtimeHandle: reference, executionGeneration: z.string().regex(/^(0|[1-9][0-9]{0,19})$/), requestId: reference });
export type GenerationBinding = z.infer<typeof GenerationBindingSchema>;
const measurement = z.number().finite().min(0).max(1_000_000_000).int().nullable().default(null);
const label = z.string().regex(/^[A-Za-z0-9@][A-Za-z0-9@_.:/-]{0,255}$/).nullable().default(null);
export const GenerationFactsSchema = z.strictObject({
  completedAt: z.iso.datetime(), modelId: label, harness: label, accessSource: label,
  inputTokens: measurement, outputTokens: measurement, cachedInputTokens: measurement,
  costUsd: z.number().finite().min(0).max(1_000_000).nullable().default(null),
  latencyMs: z.number().finite().min(0).max(86_400_000).nullable().default(null),
});
export type GenerationFacts = z.infer<typeof GenerationFactsSchema>;
export type GenerationFactsInput = z.input<typeof GenerationFactsSchema>;
export const AdmissionLeaseSchema = z.strictObject({ ownerEpoch: z.uuid(), chatEpoch: z.uuid(), sampleRateBps: z.number().int().min(0).max(10_000) });
export type AdmissionLease = z.infer<typeof AdmissionLeaseSchema>;
export const CompletedGenerationSchema = z.strictObject({ generationId: z.uuid(), binding: GenerationBindingSchema,
  lease: AdmissionLeaseSchema, capturedAt: z.iso.datetime(), sampled: z.boolean(), facts: GenerationFactsSchema });
export type CompletedGeneration = z.infer<typeof CompletedGenerationSchema>;
export type ClassificationSnapshot = Readonly<{ messages: readonly Readonly<{ role: "user" | "assistant"; text: string }>[] }>;
export type ClassificationApi = "openai-completions" | "openai-responses" | "anthropic-messages";
export const CaptureInputSchema = z.strictObject({ binding: GenerationBindingSchema,
  api: z.enum(["openai-completions", "openai-responses", "anthropic-messages"]), body: z.string().max(131072).refine(value => Buffer.byteLength(value) <= 131072), signal: z.instanceof(AbortSignal).optional() });
export const OwnerPolicySchema = z.strictObject({ enabled: z.boolean(), sampleRateBps: z.number().int().min(0).max(10_000) });
export type OwnerPolicy = z.infer<typeof OwnerPolicySchema>;
export const AggregateInputSchema = z.strictObject({ ownerId: reference, from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }),
  groupBy: z.array(z.enum(["taskFamily", "taskType", "complexity", "modelId", "harness", "accessSource"])).min(1).max(4),
  includeUnclassified: z.boolean().default(true),
  limit: z.number().int().min(1).max(200).default(200),
}).refine(value => new Set(value.groupBy).size === value.groupBy.length && Date.parse(value.to) > Date.parse(value.from)
  && Date.parse(value.to) - Date.parse(value.from) <= 31 * 86_400_000);
export type AggregateInput = z.input<typeof AggregateInputSchema>;
export class ChatAnalyticsUnavailable extends Error { constructor() { super("Chat usage unavailable"); this.name = "ChatAnalyticsUnavailable"; } }
