import { z } from "zod/v4";
import { RoutineCliErrorCodeSchema, RoutineCliOperationSchema, RoutineCliResultSchema, type RoutineCliOperation, type RoutineCliResult } from "#bots/routine-cli";
export const ROUTINE_CLI_EXECUTION_PATH = "/api/routine-cli/execute";
export const ROUTINE_CLI_AUTH_SCHEME = "RoutineCapability";
export const ROUTINE_CLI_INPUT_BYTES = 24 * 1024;
export const ROUTINE_CLI_FRAME_BYTES = 32 * 1024;
export const ROUTINE_CLI_OUTPUT_BYTES = 128 * 1024;
export const ROUTINE_CLI_SAFE_ERRORS = {
  source_context_required: "An authorized Matrix source context is required.",
  permission_denied: "This routine operation is not permitted.",
  target_required: "Choose an eligible routine destination in Matrix Settings.",
  target_unavailable: "The routine destination is unavailable.",
  revision_conflict: "The routine changed. Read its current revision.",
  request_conflict: "This request ID belongs to a different routine intent.",
  not_found: "Routine not found.",
  unavailable: "Routine requests are temporarily unavailable.",
  invalid_input: "The routine request is invalid.",
} as const;
export const RoutineCliTokenSchema = z.string().regex(/^rcli_[A-Za-z0-9_-]{43}$/);
export const RoutineCliEndpointSchema = z.string().max(2048).refine(value => {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      && !url.username && !url.password && !url.search && !url.hash && url.pathname === ROUTINE_CLI_EXECUTION_PATH;
  } catch (error: unknown) {
    if (!(error instanceof TypeError)) console.warn("[routine-cli] Endpoint invalid", error instanceof Error ? error.name : "UnknownError");
    return false;
  }
});
const ErrorSchema = z.object({ code: RoutineCliErrorCodeSchema, message: z.string().max(200) }).strict()
  .refine(error => error.message === ROUTINE_CLI_SAFE_ERRORS[error.code]);
export const RoutineCliEnvelopeSchema = z.union([
  z.object({ v: z.literal(1), ok: z.literal(true), data: RoutineCliResultSchema }).strict(),
  z.object({ v: z.literal(1), error: ErrorSchema }).strict(),
]);
export type RoutineCliEnvelope = z.infer<typeof RoutineCliEnvelopeSchema>;
export const RoutineCliChildFrameSchema = z.object({ v: z.literal(1), type: z.literal("routine.request"), operation: RoutineCliOperationSchema }).strict();
export const RoutineCliHostFrameSchema = z.discriminatedUnion("type", [
  z.object({ v: z.literal(1), type: z.literal("routine.capability"), endpoint: RoutineCliEndpointSchema, token: RoutineCliTokenSchema }).strict(),
  z.object({ v: z.literal(1), type: z.literal("routine.denied"), code: RoutineCliErrorCodeSchema }).strict(),
  z.object({ v: z.literal(1), type: z.literal("routine.cancel") }).strict(),
]);
export const RoutineCliHttpBodySchema = z.object({ operation: RoutineCliOperationSchema }).strict();

/** A well-formed result must still belong to this exact normalized operation. This is
 * response integrity, never source/action authorization or a replacement for the ledger. */
export function routineCliResultMatchesOperation(operation: RoutineCliOperation, result: RoutineCliResult): boolean {
  if (operation.operation === "list") return result.kind === "list";
  if (operation.operation === "show") return result.kind === "show" && result.routine.routineId === operation.routineId;
  if (result.kind === "not_observed") return operation.operation === "request" && result.requestId.toLowerCase() === operation.requestId.toLowerCase();
  if (result.kind === "unknown") return operation.operation !== "request" && result.requestId.toLowerCase() === operation.requestId.toLowerCase();
  if (result.kind !== "receipt" || result.receipt.requestId.toLowerCase() !== operation.requestId.toLowerCase()) return false;
  if (operation.operation === "request") return true;
  return result.receipt.operation === operation.operation && (operation.operation === "propose"
    || result.receipt.disposition !== "applied" || result.receipt.routine.routineId === operation.routineId
      && result.receipt.routine.status === ({ pause: "paused", resume: "active", archive: "archived" } as const)[operation.operation]);
}
export const ROUTINE_CLI_HTTP_STATUS = { source_context_required: 401, permission_denied: 403, invalid_input: 400, target_required: 409,
  target_unavailable: 409, revision_conflict: 409, request_conflict: 409, not_found: 404, unavailable: 503 } as const;
