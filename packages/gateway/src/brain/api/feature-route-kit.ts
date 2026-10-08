/**
 * The pieces every feature router (search, graph, brief, impact) shares, so their rules cannot drift: the fixed error
 * body, the error mapper and the project route guard. The guard sets `Cache-Control: private, no-store` on every
 * answer, then checks the request principal, then the service being on (brain_unavailable), then the project ref
 * shape (project_not_found). Nothing here registers middleware for "*".
 */
import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { requestHasBody } from "../../http-body.js";
import { isRequestPrincipalError, mapRequestPrincipalError } from "../../request-principal.js";
import {
  BRAIN_FEATURE_ERRORS, BRAIN_FEATURE_STORE_ERROR_CODES, BRAIN_PROJECT_REF_PATTERN, BrainFeatureError,
  type BrainAnyErrorCode, type BrainFeatureRoutesDeps,
} from "../contracts.js";
import { BrainStoreError } from "../types.js";
import { BRAIN_API_ERRORS, BrainApiError } from "./types.js";

const NO_STORE = "private, no-store";

/** `{ error: { code, message } }` with the code's fixed status and message. */
export function brainFail(c: Context, code: BrainAnyErrorCode): Response {
  const entry = Object.hasOwn(BRAIN_FEATURE_ERRORS, code)
    ? BRAIN_FEATURE_ERRORS[code as keyof typeof BRAIN_FEATURE_ERRORS]
    : BRAIN_API_ERRORS[code as keyof typeof BRAIN_API_ERRORS];
  c.header("Cache-Control", NO_STORE);
  return c.json({ error: { code, message: entry.message } }, entry.status);
}

/** Principal errors, body size, feature, API and store codes, boundary parse errors, then a logged generic 503. */
export function brainHandleError(c: Context, error: unknown, logPrefix: string): Response {
  if (isRequestPrincipalError(error)) {
    const mapped = mapRequestPrincipalError(error, "Company brain request failed");
    if (mapped.log) console.error(`[${logPrefix}] Request principal misconfigured:`, error.name);
    c.header("Cache-Control", NO_STORE);
    return c.json(mapped.body, mapped.status);
  }
  if (error instanceof Error && error.name === "BodyLimitError") return brainFail(c, "body_too_large");
  if (error instanceof BrainFeatureError || error instanceof BrainApiError) return brainFail(c, error.code);
  if (error instanceof BrainStoreError) return brainFail(c, BRAIN_FEATURE_STORE_ERROR_CODES[error.code]);
  if (error instanceof z.ZodError || error instanceof SyntaxError) return brainFail(c, "invalid_request");
  console.error(`[${logPrefix}] Request failed:`, error instanceof Error ? error.name : "UnknownError");
  return brainFail(c, "brain_unavailable");
}

export type BrainProjectHandler<TService> =
  (c: Context, ownerId: string, service: TService, projectRef: string) => Promise<Response>;

/** Wraps a handler in the guard and the error mapper; `logPrefix` names the router in server logs. */
export function brainProjectRoute<TService>(deps: BrainFeatureRoutesDeps<TService>, logPrefix: string) {
  return (handler: BrainProjectHandler<TService>) => async (c: Context): Promise<Response> => {
    c.header("Cache-Control", NO_STORE);
    try {
      const principal = deps.getPrincipal(c);
      if (deps.service === null) return brainFail(c, "brain_unavailable");
      const projectRef = c.req.param("projectId");
      if (!projectRef || !BRAIN_PROJECT_REF_PATTERN.test(projectRef)) return brainFail(c, "project_not_found");
      return await handler(c, principal.userId, deps.service, projectRef);
    } catch (error: unknown) {
      return brainHandleError(c, error, logPrefix);
    }
  };
}

/** bodyLimit answering body_too_large with the fixed body. */
export function brainBodyLimit(maxSize: number): MiddlewareHandler {
  return bodyLimit({ maxSize, onError: (c) => brainFail(c, "body_too_large") });
}

/** The JSON body through a strict schema; no body reads as {}. */
export async function readBrainBody<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(requestHasBody(c) ? await c.req.json() : {});
}
