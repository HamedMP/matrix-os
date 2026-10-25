import { z } from "zod/v4";

const count = z.number().int().min(0).max(200_000);
const measurement = z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER).nullable();
const identifier = z.string().min(1).max(200).regex(/^[A-Za-z0-9@][A-Za-z0-9@._:/ -]*$/).nullable();
const family = z.enum(["coding", "research", "writing", "translation", "planning", "data_analysis", "question_answering", "other"]);
const task = z.enum(["generate", "debug", "review", "explain", "refactor", "tests", "lookup", "compare", "synthesis", "draft", "rewrite", "summarize", "translate", "plan", "analyze", "answer", "other"]);
export const chatUsageGroups = {
  taskFamily: "task family", taskType: "task type", complexity: "complexity estimate", modelId: "model", harness: "agent", accessSource: "access source",
} as const;
export type ChatUsageGroup = keyof typeof chatUsageGroups;
const group = z.enum(["taskFamily", "taskType", "complexity", "modelId", "harness", "accessSource"]);
const Policy = z.strictObject({ enabled: z.boolean(), sampleRateBps: z.number().int().min(0).max(10_000),
  modelId: identifier.unwrap(), recipient: z.literal("Cloudflare Workers AI"), disclosureVersion: z.literal("chat-usage-v1"), retentionDays: z.literal(30) });
const Mutation = z.strictObject({ enabled: z.boolean(), sampleRateBps: z.number().int().min(0).max(10_000),
  disclosureVersion: z.literal("chat-usage-v1").optional() }).refine(value => !value.enabled || value.disclosureVersion === "chat-usage-v1");
const Bucket = z.strictObject({ dimensions: z.strictObject({ taskFamily: family.nullable().optional(), taskType: task.nullable().optional(),
  complexity: z.enum(["low", "medium", "high"]).nullable().optional(), modelId: identifier.optional(), harness: identifier.optional(), accessSource: identifier.optional(),
}).refine(value => Object.keys(value).length >= 1 && Object.keys(value).length <= 4),
generations: count, classified: count, sampled: count, inputTokens: measurement, outputTokens: measurement, cachedInputTokens: measurement,
costUsd: measurement, latencyMsMean: measurement,
unknownInputTokenGenerations: count, unknownOutputTokenGenerations: count, unknownCachedInputTokenGenerations: count,
unknownCostGenerations: count, unknownLatencyGenerations: count,
samplingRateBpsMin: z.number().int().min(0).max(10_000), samplingRateBpsMax: z.number().int().min(0).max(10_000),
}).refine(value => value.classified <= value.sampled && value.sampled <= value.generations
  && value.samplingRateBpsMin <= value.samplingRateBpsMax
  && [value.unknownInputTokenGenerations, value.unknownOutputTokenGenerations, value.unknownCachedInputTokenGenerations,
    value.unknownCostGenerations, value.unknownLatencyGenerations].every(unknown => unknown <= value.generations));
const Summary = z.strictObject({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }),
  buckets: z.array(Bucket).max(200), groupLimit: z.number().int().min(1).max(200), mayBeTruncated: z.boolean(), classificationIsEstimate: z.literal(true),
}).refine(value => value.buckets.length <= value.groupLimit && Date.parse(value.to) > Date.parse(value.from)
  && Date.parse(value.to) - Date.parse(value.from) <= 31 * 86_400_000);
export type ChatUsagePolicy = z.infer<typeof Policy>;
export type ChatUsageSummary = z.infer<typeof Summary>;
export type ChatUsageMutation = z.infer<typeof Mutation>;
export interface ChatUsageRequest { path: string; method: "GET" | "PUT" | "DELETE"; body?: unknown; signal: AbortSignal }
export class ChatUsageUnavailable extends Error { constructor() { super("Chat usage is unavailable."); this.name = "ChatUsageUnavailable"; } }

/** Authenticated transport is injected by the current shell/runtime, never selected by a response. */
export function createChatUsageClient(request: (input: ChatUsageRequest) => Promise<unknown>, isIdentityCurrent = () => true) {
  async function read<T>(schema: z.ZodType<T>, input: ChatUsageRequest): Promise<T> {
    try {
      if (input.signal.aborted || !isIdentityCurrent()) throw new ChatUsageUnavailable();
      const value = await request(input);
      if (input.signal.aborted || !isIdentityCurrent()) throw new ChatUsageUnavailable();
      const result = schema.safeParse(value);
      if (!result.success) throw new ChatUsageUnavailable();
      return result.data;
    } catch (error: unknown) {
      if (error instanceof ChatUsageUnavailable) throw error;
      throw new ChatUsageUnavailable();
    }
  }
  return {
    policy: (signal: AbortSignal) => read(Policy, { path: "/api/chat-usage/policy", method: "GET", signal }),
    async summary(dimension: ChatUsageGroup, signal: AbortSignal) {
      if (!group.safeParse(dimension).success) throw new ChatUsageUnavailable();
      const result = await read(Summary, { path: `/api/chat-usage/summary?groupBy=${dimension}&limit=100`, method: "GET", signal });
      if (result.buckets.some(bucket => Object.keys(bucket.dimensions).length !== 1 || !(dimension in bucket.dimensions))) throw new ChatUsageUnavailable();
      return result;
    },
    async configure(input: ChatUsageMutation, signal: AbortSignal) {
      const parsed = Mutation.safeParse(input);
      if (!parsed.success) throw new ChatUsageUnavailable();
      return read(Policy, { path: "/api/chat-usage/policy", method: "PUT", body: parsed.data, signal });
    },
    deleteData: (signal: AbortSignal) => read(z.strictObject({ deleted: z.literal(true), enabled: z.literal(false) }),
      { path: "/api/chat-usage/data", method: "DELETE", body: {}, signal }),
  };
}
export type ChatUsageClient = ReturnType<typeof createChatUsageClient>;
