import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { ROUTINE_ACTION_PATH, ROUTINE_ACTION_PROOF_HEADER, RoutineActionIdSchema, RoutineActionSubmitSchema, RoutineActionViewSchema } from "@matrix-os/contracts";
import { ROUTINE_CLI_HTTP_STATUS, ROUTINE_CLI_SAFE_ERRORS, type RoutineCliErrorCode } from "@matrix-os/contracts/routine-cli";
import type { RoutineCliActionController } from "./routine-action-controller.js";
import { RoutineCliError } from "./routine-cli-errors.js";
import { isRequestPrincipalError, mapRequestPrincipalError, type RequestPrincipal } from "../request-principal.js";
type Actions = Pick<RoutineCliActionController, "get" | "list" | "submit">;
/** Owner routing auth is required for read/submit; proof is separately required for the actual decision.
 * No source capability exemption; GET/open/focus never decides. */
export function createRoutineActionOwnerRoutes(options: { actions: Actions | null; getPrincipal(c: Context): RequestPrincipal }) {
  if (!options.getPrincipal || options.actions !== null && ["get", "list", "submit"].some(key => typeof options.actions?.[key as keyof Actions] !== "function")) throw new Error("Routine action routes unavailable");
  const app = new Hono(), requireActions = () => { if (!options.actions) throw new RoutineCliError("unavailable"); return options.actions; };
  const error = (c: Context, code: RoutineCliErrorCode, status: typeof ROUTINE_CLI_HTTP_STATUS[RoutineCliErrorCode] | 413 = ROUTINE_CLI_HTTP_STATUS[code]) => c.json({ code, message: ROUTINE_CLI_SAFE_ERRORS[code] }, status);
  app.onError((failure: unknown, c) => {
    if (isRequestPrincipalError(failure)) { const mapped = mapRequestPrincipalError(failure); return c.json(mapped.body, mapped.status); }
    if (failure instanceof RoutineCliError) return error(c, failure.code);
    if (failure instanceof z.ZodError || failure instanceof SyntaxError) return error(c, "invalid_input");
    console.warn("[routine-action] Request unavailable", failure instanceof Error ? failure.name : "UnknownError"); return error(c, "unavailable");
  });
  app.use(`${ROUTINE_ACTION_PATH}*`, async (c, next) => { c.header("Cache-Control", "private, no-store"); if (new URL(c.req.url).search) return error(c, "invalid_input"); await next(); });
  app.get(ROUTINE_ACTION_PATH, c => c.json({ challenges: z.array(RoutineActionViewSchema).max(128).parse(requireActions().list(options.getPrincipal(c))) }));
  app.get(`${ROUTINE_ACTION_PATH}/:id`, c => c.json(RoutineActionViewSchema.parse(requireActions().get(options.getPrincipal(c), RoutineActionIdSchema.parse(c.req.param("id"))))));
  app.post(`${ROUTINE_ACTION_PATH}/:id/decision`, bodyLimit({ maxSize: 2048, onError: c => error(c, "invalid_input", 413) }), async c => {
    const principal = options.getPrincipal(c), id = RoutineActionIdSchema.parse(c.req.param("id"));
    const proof = c.req.header(ROUTINE_ACTION_PROOF_HEADER); if (!proof || proof.length > 4000) return error(c, "permission_denied");
    const body = RoutineActionSubmitSchema.parse(await c.req.json());
    return c.json(await requireActions().submit(principal, id, body, proof));
  });
  return app;
}
