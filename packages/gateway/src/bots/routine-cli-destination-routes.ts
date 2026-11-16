import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { ROUTINE_DESTINATION_PATH, RoutineDestinationViewSchema, RoutineCliRememberTargetSchema, RoutineCliResetTargetSchema } from "@matrix-os/contracts/routine-destination";
import { ROUTINE_CLI_SAFE_ERRORS, ROUTINE_CLI_HTTP_STATUS, type RoutineCliErrorCode } from "@matrix-os/contracts/routine-cli";
import { isRequestPrincipalError, mapRequestPrincipalError, type RequestPrincipal } from "../request-principal.js";
import type { RoutineCliTargetService } from "./routine-cli-targets.js";
import { RoutineCliError } from "./routine-cli-errors.js";
type Targets = Pick<RoutineCliTargetService, "getOwnerView" | "remember" | "reset">;
/** Auth matrix: ordinary authenticated owner only, configured owner+Computer in TargetService.
 * No source-scheme exemption. Null is an explicit unavailable startup configuration; omitted deps fail registration. */
export function createRoutineCliDestinationRoutes(deps: { targets: Targets | null; getPrincipal(c: Context): RequestPrincipal }) {
  if (typeof deps.getPrincipal !== "function" || deps.targets !== null && (!deps.targets || ["getOwnerView", "remember", "reset"].some(name => typeof deps.targets?.[name as keyof Targets] !== "function"))) throw new Error("Routine destination dependencies unavailable");
  const targets = deps.targets, getPrincipal = deps.getPrincipal, app = new Hono();
  const error = (c: Context, code: RoutineCliErrorCode, status: typeof ROUTINE_CLI_HTTP_STATUS[RoutineCliErrorCode] | 413 = ROUTINE_CLI_HTTP_STATUS[code]) => {
    c.header("Cache-Control", "private, no-store"); return c.json({ code, message: ROUTINE_CLI_SAFE_ERRORS[code] }, status);
  };
  app.onError((failure: unknown, c) => {
    if (isRequestPrincipalError(failure)) { const mapped = mapRequestPrincipalError(failure); return c.json(mapped.body, mapped.status); }
    if (failure instanceof RoutineCliError) return error(c, failure.code);
    if (failure instanceof z.ZodError || failure instanceof SyntaxError) return error(c, "invalid_input");
    console.warn("[routine-destination] Request unavailable", failure instanceof Error ? failure.name : "UnknownError"); return error(c, "unavailable");
  });
  app.use(`${ROUTINE_DESTINATION_PATH}*`, async (c, next) => { c.header("Cache-Control", "private, no-store"); await next(); });
  const requireTargets = () => { if (!targets) throw new RoutineCliError("unavailable"); return targets; };
  const limit = bodyLimit({ maxSize: 2048, onError: c => error(c, "invalid_input", 413) });
  app.get(ROUTINE_DESTINATION_PATH, async c => {
    const principal = getPrincipal(c); if (new URL(c.req.url).search) return error(c, "invalid_input");
    return c.json(RoutineDestinationViewSchema.parse(await requireTargets().getOwnerView(principal)));
  });
  app.post(ROUTINE_DESTINATION_PATH, limit, async c => {
    const principal = getPrincipal(c); if (new URL(c.req.url).search) return error(c, "invalid_input");
    const body = RoutineCliRememberTargetSchema.parse(await c.req.json());
    return c.json(RoutineDestinationViewSchema.parse({ preference: await requireTargets().remember(principal, body), availability: "available" }));
  });
  app.post(`${ROUTINE_DESTINATION_PATH}/reset`, limit, async c => {
    const principal = getPrincipal(c); if (new URL(c.req.url).search) return error(c, "invalid_input");
    const body = RoutineCliResetTargetSchema.parse(await c.req.json());
    return c.json(RoutineDestinationViewSchema.parse({ preference: await requireTargets().reset(principal, body), availability: "unset" }));
  });
  return app;
}
