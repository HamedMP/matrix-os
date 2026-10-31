import { z } from "zod/v4";
import { RoutineCliActionSchema } from "@matrix-os/contracts";
import { RoutineCliScopeSchema } from "./repositories/routine-cli-preferences.js";

const ref = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const SourceIdentitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("chat_run"), chatId: ref, runId: ref, nativeTurnId: ref.optional(), route: z.enum(["native", "managed"]) }).strict(),
  z.object({ kind: z.literal("terminal_launch"), sessionId: ref, incarnationId: ref, launchId: ref }).strict(),
  z.object({ kind: z.literal("bot_child"), taskId: ref, runId: ref, runtimeHandle: ref, childInvocationId: ref.optional() }).strict(),
]);
/** Validation of injected host state only; never exported as a CLI/body parser. */
export const RoutineCliSourceContextSchema = RoutineCliScopeSchema.extend({
  harness: z.enum(["claude", "codex", "hermes", "opencode", "pi"]),
  identity: SourceIdentitySchema, generation: ref,
  issuedAt: z.iso.datetime({ offset: true }), expiresAt: z.iso.datetime({ offset: true }),
  actions: z.array(RoutineCliActionSchema).max(3).refine(actions => new Set(actions).size === actions.length),
}).strict();
export type RoutineCliSourceContext = z.infer<typeof RoutineCliSourceContextSchema>;
