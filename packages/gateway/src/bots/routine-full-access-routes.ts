import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { CanonicalChatIdSchema, RoutineFullAccessIdSchema, RoutineFullAccessCreateChallengeSchema,
  RoutineFullAccessRevokeSchema, RoutineFullAccessDecisionSubmitSchema, RoutineFullAccessStatusSchema,
  ROUTINE_FULL_ACCESS_PROOF_HEADER } from "@matrix-os/contracts";
import { ROUTINE_CLI_SAFE_ERRORS, ROUTINE_CLI_HTTP_STATUS, type RoutineCliErrorCode } from "@matrix-os/contracts/routine-cli";
import { isRequestPrincipalError, mapRequestPrincipalError, type RequestPrincipal } from "../request-principal.js";
import { RoutineCliError } from "./routine-cli-errors.js";
import type { RoutineFullAccessService } from "./routine-full-access.js";
type Service = Pick<RoutineFullAccessService, "status" | "createChallenge" | "submitDecision" | "revoke">;
/** Owner auth only selects the private Chat; scope approval additionally requires fresh Platform proof.
 * Null explicitly exposes unavailable startup. No source-scheme auth exemption or body-selected identity. */
export function createRoutineFullAccessRoutes(deps: { service: Service | null; unconfigured?: boolean; getPrincipal(c: Context): RequestPrincipal }) {
  if (typeof deps.getPrincipal !== "function" || deps.service !== null && (!deps.service
    || ["status", "createChallenge", "submitDecision", "revoke"].some(key => typeof deps.service?.[key as keyof Service] !== "function")))
    throw new Error("Routine origin dependencies unavailable");
  const app = new Hono(), path = "/api/chats/:chatId/routine-cli/full-access";
  const error = (c: Context, code: RoutineCliErrorCode, status: typeof ROUTINE_CLI_HTTP_STATUS[RoutineCliErrorCode] | 413 = ROUTINE_CLI_HTTP_STATUS[code]) => {
    c.header("Cache-Control", "private, no-store"); return c.json({ code, message: ROUTINE_CLI_SAFE_ERRORS[code] }, status);
  };
  app.onError((failure: unknown, c) => {
    if (isRequestPrincipalError(failure)) { const mapped = mapRequestPrincipalError(failure); return c.json(mapped.body, mapped.status); }
    if (failure instanceof RoutineCliError) return error(c, failure.code);
    if (failure instanceof z.ZodError || failure instanceof SyntaxError) return error(c, "invalid_input");
    console.warn("[routine-origin] Request unavailable", failure instanceof Error ? failure.name : "UnknownError"); return error(c, "unavailable");
  });
  app.use(`${path}*`, async (c, next) => { c.header("Cache-Control", "private, no-store"); await next(); });
  const service = () => { if (!deps.service) throw new RoutineCliError("unavailable"); return deps.service; };
  const context = (c: Context) => {
    const principal = deps.getPrincipal(c), chatId = CanonicalChatIdSchema.parse(c.req.param("chatId"));
    if (new URL(c.req.url).search) throw new RoutineCliError("invalid_input");
    return { principal, chatId };
  };
  const limit = bodyLimit({ maxSize: 4000, onError: c => error(c, "invalid_input", 413) });
  app.get(path, async c => {
    const { principal, chatId } = context(c);
    if (!deps.service && deps.unconfigured) {
      return c.json(RoutineFullAccessStatusSchema.parse({
        revision: 0, eligibility: "ineligible", origin: "browser_required", consent: null, challenge: null,
      }));
    }
    return c.json(RoutineFullAccessStatusSchema.parse(await service().status(principal, chatId))); });
  app.post(`${path}/challenges`, limit, async c => { const { principal, chatId } = context(c);
    return c.json(RoutineFullAccessStatusSchema.parse(await service().createChallenge(principal, chatId,
      RoutineFullAccessCreateChallengeSchema.parse(await c.req.json())))); });
  app.post(`${path}/challenges/:challengeId/decision`, limit, async c => { const { principal, chatId } = context(c);
    const id = RoutineFullAccessIdSchema.parse(c.req.param("challengeId")), body = RoutineFullAccessDecisionSubmitSchema.parse(await c.req.json());
    const proof = c.req.header(ROUTINE_FULL_ACCESS_PROOF_HEADER);
    if (!proof || proof.length > 4000) throw new RoutineCliError("permission_denied");
    return c.json(RoutineFullAccessStatusSchema.parse(await service().submitDecision(principal, chatId, id, body, proof))); });
  app.post(`${path}/revoke`, limit, async c => { const { principal, chatId } = context(c);
    return c.json(RoutineFullAccessStatusSchema.parse(await service().revoke(principal, chatId,
      RoutineFullAccessRevokeSchema.parse(await c.req.json())))); });
  return app;
}
