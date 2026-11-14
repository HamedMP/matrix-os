import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { RoutineCliHttpBodySchema, RoutineCliTokenSchema, RoutineCliEnvelopeSchema, ROUTINE_CLI_EXECUTION_PATH,
  ROUTINE_CLI_HTTP_STATUS, ROUTINE_CLI_AUTH_SCHEME, ROUTINE_CLI_FRAME_BYTES, ROUTINE_CLI_OUTPUT_BYTES, ROUTINE_CLI_SAFE_ERRORS, type RoutineCliErrorCode } from "@matrix-os/contracts/routine-cli";
import { RoutineCliError } from "./routine-cli-errors.js";
import type { RoutineCliRequestService } from "./routine-cli-requests.js";
/** Auth matrix: exact raw POST only, route-owned one-shot source capability, NEVER RequestPrincipal.
 * Registration requires the actual configured RequestService. No producer/issuer or owner-JWT proxy is installed. */
export function createRoutineCliExecutionRoutes(deps: { requests: Pick<RoutineCliRequestService, "execute"> }) {
  if (typeof deps.requests?.execute !== "function") throw new Error("Routine CLI service unavailable");
  const app = new Hono();
  const error = (c: import("hono").Context, code: RoutineCliErrorCode, status: typeof ROUTINE_CLI_HTTP_STATUS[RoutineCliErrorCode] | 413 = ROUTINE_CLI_HTTP_STATUS[code]) => {
    c.header("Cache-Control", "private, no-store"); return c.json({ v: 1, error: { code, message: ROUTINE_CLI_SAFE_ERRORS[code] } }, status);
  };
  app.post(ROUTINE_CLI_EXECUTION_PATH, bodyLimit({ maxSize: ROUTINE_CLI_FRAME_BYTES, onError: c => error(c, "invalid_input", 413) }), async c => {
    const url = new URL(c.req.raw.url), header = c.req.header("authorization");
    if (url.pathname !== ROUTINE_CLI_EXECUTION_PATH || url.search || ["x-platform-user-id", "x-platform-verified", "x-matrix-clerk-user-id", "x-matrix-user-id", "x-clerk-user-id"].some(name => c.req.raw.headers.has(name))) return error(c, "permission_denied");
    if (!header?.startsWith(ROUTINE_CLI_AUTH_SCHEME + " ")) return error(c, "source_context_required");
    const token = RoutineCliTokenSchema.safeParse(header.slice(ROUTINE_CLI_AUTH_SCHEME.length + 1));
    if (!token.success) return error(c, "permission_denied");
    if (c.req.header("content-type")?.split(";", 1)[0]?.trim() !== "application/json") return error(c, "invalid_input");
    try {
      const parsed = RoutineCliHttpBodySchema.safeParse(await c.req.json());
      if (!parsed.success) return error(c, "invalid_input");
      const data = await deps.requests.execute({ token: token.data, operation: parsed.data.operation });
      const envelope = RoutineCliEnvelopeSchema.parse({ v: 1, ok: true, data }), json = JSON.stringify(envelope);
      if (Buffer.byteLength(json) > ROUTINE_CLI_OUTPUT_BYTES) return error(c, "unavailable");
      c.header("Cache-Control", "private, no-store"); c.header("Content-Type", "application/json"); return c.body(json, 200);
    } catch (failure: unknown) {
      if (failure instanceof RoutineCliError) return error(c, failure.code);
      if (failure instanceof SyntaxError) return error(c, "invalid_input");
      console.warn("[routine-cli-route] Request unavailable", failure instanceof Error ? failure.name : "UnknownError");
      return error(c, "unavailable");
    }
  });
  return app;
}
