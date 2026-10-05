import { z } from "zod/v4";

export const LIMITS = { cases: 2000, steps: 100100, sources: 100100, text: 100000, hits: 100, timeoutMs: 30000 } as const;
const id = z.string().min(1).max(180).regex(/^[a-zA-Z0-9._:-]+$/);
const timestamp = z.iso.datetime();
export const placementSchema = z.enum(["fact", "preference", "instruction", "event", "procedure", "source"]);
const pathSchema = z.string().min(1).max(500).refine((p) => !p.startsWith("/") && !p.includes("\\") && !p.split("/").some((s) => s === ".." || s === "." || !s), "Source paths must be relative and contained");
export const sourceSchema = z.object({
  id, scope: id, path: pathSchema, text: z.string().min(1).max(LIMITS.text),
  role: z.enum(["user", "assistant", "tool", "document"]), observedAt: timestamp,
}).strict();
export const querySchema = z.object({
  text: z.string().min(1).max(4000), scopes: z.array(id).max(50),
  at: timestamp, validAt: timestamp.optional(), knownAt: timestamp.optional(),
  budgetTokens: z.number().int().min(1).max(32000), limit: z.number().int().min(1).max(LIMITS.hits),
  session: id,
}).strict();
const expectedSchema = z.object({
  relevant: z.array(id).max(100), forbidden: z.array(id).max(100).default([]),
  status: z.enum(["evidence", "unknown", "disputed"]),
  requiredText: z.record(id, z.string().min(1).max(1000)).optional(),
}).strict();
const stepSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ingest"), source: sourceSchema,
    expected: z.object({ action: z.enum(["retain", "skip"]), placements: z.array(placementSchema).max(6), retentionAllowed: z.boolean().default(true) }).strict(),
  }).strict(),
  z.object({ type: z.literal("query"), query: querySchema, expected: expectedSchema }).strict(),
  z.object({ type: z.literal("forget"), sourceId: id }).strict(),
  z.object({ type: z.literal("revoke"), scope: id }).strict(),
]);
export const suiteSchema = z.object({
  version: z.literal("1"), name: id, seed: z.number().int().min(0).max(0xffffffff),
  split: z.enum(["dev", "test"]), description: z.string().max(4000),
  cases: z.array(z.object({ id, group: id, steps: z.array(stepSchema).min(1).max(LIMITS.steps) }).strict()).min(1).max(LIMITS.cases),
}).strict().superRefine((suite, ctx) => {
  const ids: string[] = [];
  let totalSteps = 0;
  for (const c of suite.cases) {
    if (ids.includes(c.id)) ctx.addIssue({ code: "custom", message: "Duplicate case ID" });
    ids.push(c.id);
    const sources = new Map<string, z.infer<typeof sourceSchema>>(); // Step cap bounds this case-local registry.
    let previous = "";
    for (const step of c.steps) {
      totalSteps++;
      if (step.type === "ingest") sources.set(step.source.id, step.source);
      if (step.type === "forget" && !sources.has(step.sourceId)) ctx.addIssue({ code: "custom", message: "Forget references unavailable source" });
      const time = step.type === "ingest" ? step.source.observedAt : step.type === "query" ? step.query.at : previous;
      if (previous && Date.parse(time) < Date.parse(previous)) ctx.addIssue({ code: "custom", message: "Steps must be chronological" });
      previous = time;
      if (step.type === "query") {
        for (const ref of [...step.expected.relevant, ...step.expected.forbidden]) {
          if (!sources.has(ref)) ctx.addIssue({ code: "custom", message: "Query labels reference future or missing source" });
        }
        for (const [ref, text] of Object.entries(step.expected.requiredText ?? {})) {
          if (!step.expected.relevant.includes(ref) || !sources.get(ref)?.text.includes(text)) ctx.addIssue({ code: "custom", message: "Evidence labels must resolve to relevant source text" });
        }
        if (new Set(step.expected.relevant).size !== step.expected.relevant.length) ctx.addIssue({ code: "custom", message: "Duplicate relevance labels" });
      }
    }
  }
  if (totalSteps > 250000) ctx.addIssue({ code: "custom", message: "Suite exceeds total step cap" });
});
export const telemetrySchema = z.object({
  costUsd: z.number().finite().min(0).max(10000).optional(),
  inputTokens: z.number().int().min(0).max(10000000).optional(),
  outputTokens: z.number().int().min(0).max(10000000).optional(),
  calls: z.array(z.object({ id: id.optional(), parentId: id.optional(), role: z.enum(["router", "extractor", "verifier", "consolidator", "retriever", "reader"]),
    model: z.string().max(200), latencyMs: z.number().finite().min(0), costUsd: z.number().finite().min(0).optional(),
  }).strict()).max(50).optional(),
}).strict();
export const admissionSchema = z.object({
  action: z.enum(["retain", "skip"]), placements: z.array(placementSchema).max(6), telemetry: telemetrySchema.optional(),
}).strict();
export const retrievalSchema = z.object({
  status: z.enum(["evidence", "unknown", "disputed"]),
  hits: z.array(z.object({ sourceId: id, text: z.string().min(1).max(LIMITS.text),
    start: z.number().int().min(0), end: z.number().int().min(1),
  }).strict()).max(LIMITS.hits), telemetry: telemetrySchema.optional(),
}).strict();
export const metadataSchema = z.object({
  name: z.string().min(1).max(200), version: z.string().min(1).max(200),
  configuration: z.record(z.string().max(100), z.union([z.string().max(1000), z.number().finite(), z.boolean(), z.null()])).refine((c) => Object.keys(c).length <= 30),
}).strict();
export type Suite = z.infer<typeof suiteSchema>;
export type Source = z.infer<typeof sourceSchema>;
export type Query = z.infer<typeof querySchema>;
export type ExpectedQuery = z.infer<typeof expectedSchema>;
export type Admission = z.infer<typeof admissionSchema>;
export type Retrieval = z.infer<typeof retrievalSchema>;
export type Metadata = z.infer<typeof metadataSchema>;
export interface MemoryAdapter {
  metadata: Metadata;
  ingest(source: Source, signal: AbortSignal): Promise<Admission>;
  retrieve(query: Query, signal: AbortSignal): Promise<Retrieval>;
  forget(sourceId: string, signal: AbortSignal): Promise<{ telemetry?: z.infer<typeof telemetrySchema> } | void>;
  revoke(scope: string, signal: AbortSignal): Promise<{ telemetry?: z.infer<typeof telemetrySchema> } | void>;
  close(): Promise<void>;
}
export type AdapterFactory = (signal: AbortSignal) => MemoryAdapter | Promise<MemoryAdapter>;
