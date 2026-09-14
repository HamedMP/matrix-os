import { z } from "zod/v4";

const ContextSchema = z.object({
  version: z.literal(1),
  kind: z.literal("collaboration_scope"),
  scopeId: z.string().uuid(),
  resourceId: z.string().min(1).max(256),
  authEpoch: z.string().regex(/^(0|[1-9][0-9]{0,19})$/),
  executionGeneration: z.string().regex(/^(0|[1-9][0-9]{0,19})$/),
  supervisorHandle: z.string().regex(/^runtime_[a-f0-9]{32}$/),
  profileId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  profileVersion: z.number().int().min(1).max(1_000_000),
  profileDigest: z.string().regex(/^[a-f0-9]{64}$/),
  actorId: z.string().min(1).max(128),
  runId: z.string().min(1).max(256),
  adapterId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  harnessVersion: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/),
}).strict();

export type ScopeBoundExecutionContext = z.infer<typeof ContextSchema>;

export class CollaborationExecutionContextError extends Error {
  constructor() {
    super("Collaboration execution state is unavailable");
    this.name = "CollaborationExecutionContextError";
  }
}

export function createScopeBoundExecutionContext(
  input: Omit<ScopeBoundExecutionContext, "version" | "kind">,
): ScopeBoundExecutionContext {
  try {
    return ContextSchema.parse({ version: 1, kind: "collaboration_scope", ...input });
  } catch (error: unknown) {
    if (!(error instanceof z.ZodError)) {
      console.warn("[collaboration] execution context validation failed");
    }
    throw new CollaborationExecutionContextError();
  }
}

export function resolveScopeBoundResume<T>(input: {
  expected: ScopeBoundExecutionContext;
  state: unknown;
  parseState(value: unknown): T;
}): T {
  try {
    const expected = ContextSchema.parse(input.expected);
    const state = z.object({
      schemaVersion: z.number().int(),
      value: z.unknown(),
      provenance: ContextSchema,
    }).strict().parse(input.state);
    for (const key of Object.keys(ContextSchema.shape) as Array<keyof ScopeBoundExecutionContext>) {
      if (state.provenance[key] !== expected[key]) throw new CollaborationExecutionContextError();
    }
    return input.parseState(state.value);
  } catch (error: unknown) {
    if (error instanceof CollaborationExecutionContextError) throw error;
    throw new CollaborationExecutionContextError();
  }
}
