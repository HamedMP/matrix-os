import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod/v4";
import {
  CreateAgentThreadRequestSchema,
  CursorSchema,
  RequestIdSchema,
  ThreadIdSchema,
  SafeClientErrorSchema,
  boundedListSchema,
  AgentThreadSummarySchema,
} from "@matrix-os/contracts";
import {
  isRequestPrincipalError,
  mapRequestPrincipalError,
  requireRequestPrincipal,
  type RequestPrincipal,
} from "../request-principal.js";
import type { CodingAgentRuntimeSummaryService } from "./runtime-summary.js";
import {
  CodingAgentThreadError,
  safeThreadError,
  type CodingAgentThreadStore,
} from "./thread-store.js";

export interface CodingAgentRouteDeps {
  service: CodingAgentRuntimeSummaryService;
  threads?: CodingAgentThreadStore;
  getPrincipal?: (c: Context) => RequestPrincipal;
}

const THREAD_MUTATION_BODY_LIMIT = 128 * 1024;
const THREAD_ABORT_BODY_LIMIT = 1024;

const AbortThreadBodySchema = z.object({
  clientRequestId: RequestIdSchema,
}).strict();

const ThreadListSchema = boundedListSchema(AgentThreadSummarySchema, 50);

function summaryUnavailable() {
  return SafeClientErrorSchema.parse({
    code: "summary_unavailable",
    safeMessage: "Runtime summary is temporarily unavailable. Try again.",
    retryable: true,
    recoveryActions: ["retry"],
  });
}

function threadsUnavailable() {
  return SafeClientErrorSchema.parse({
    code: "thread_store_unavailable",
    safeMessage: "Agent thread state is temporarily unavailable. Try again.",
    retryable: true,
    recoveryActions: ["retry"],
  });
}

function validationFailed() {
  return SafeClientErrorSchema.parse({
    code: "validation_failed",
    safeMessage: "Request could not be processed. Check the inputs and try again.",
    retryable: false,
  });
}

function mapThreadRouteError(c: Context, err: unknown) {
  if (isRequestPrincipalError(err)) {
    const mapped = mapRequestPrincipalError(err);
    return c.json(mapped.body, mapped.status as ContentfulStatusCode);
  }
  if (err instanceof CodingAgentThreadError) {
    const status = err.code === "thread_not_found" ? 404 : err.code === "provider_unavailable" ? 400 : 503;
    return c.json({ error: safeThreadError(err.code) }, status);
  }
  if (err instanceof z.ZodError) {
    return c.json({ error: validationFailed() }, 400);
  }
  console.warn("[coding-agents] thread route failed:", err instanceof Error ? err.message : String(err));
  return c.json({ error: threadsUnavailable() }, 503);
}

export function createCodingAgentRoutes(deps: CodingAgentRouteDeps): Hono {
  const app = new Hono();
  const principalFor = (c: Context) => deps.getPrincipal?.(c) ?? requireRequestPrincipal(c);
  const threadMutationBodyLimit = bodyLimit({ maxSize: THREAD_MUTATION_BODY_LIMIT });
  const threadAbortBodyLimit = bodyLimit({ maxSize: THREAD_ABORT_BODY_LIMIT });

  app.get("/summary", async (c) => {
    try {
      const principal = principalFor(c);
      return c.json(await deps.service.getSummary(principal));
    } catch (err: unknown) {
      if (isRequestPrincipalError(err)) {
        const mapped = mapRequestPrincipalError(err);
        return c.json(mapped.body, mapped.status as ContentfulStatusCode);
      }
      console.warn("[coding-agents] summary route failed:", err instanceof Error ? err.message : String(err));
      return c.json({ error: summaryUnavailable() }, 503);
    }
  });

  if (deps.threads) {
    app.post("/threads", threadMutationBodyLimit, async (c) => {
      try {
        const principal = principalFor(c);
        const request = CreateAgentThreadRequestSchema.parse(await c.req.json());
        const result = await deps.threads!.createThread(principal, request);
        return c.json(result.snapshot, result.existing ? 200 : 202);
      } catch (err: unknown) {
        return mapThreadRouteError(c, err);
      }
    });

    app.get("/threads", async (c) => {
      try {
        const principal = principalFor(c);
        return c.json(ThreadListSchema.parse(await deps.threads!.listThreads(principal)));
      } catch (err: unknown) {
        return mapThreadRouteError(c, err);
      }
    });

    app.get("/threads/:threadId", async (c) => {
      try {
        const principal = principalFor(c);
        const threadId = ThreadIdSchema.parse(c.req.param("threadId"));
        return c.json(await deps.threads!.getThread(principal, threadId));
      } catch (err: unknown) {
        return mapThreadRouteError(c, err);
      }
    });

    app.get("/threads/:threadId/events", async (c) => {
      try {
        const principal = principalFor(c);
        const threadId = ThreadIdSchema.parse(c.req.param("threadId"));
        const rawCursor = c.req.query("cursor");
        const cursor = rawCursor ? CursorSchema.parse(rawCursor) : undefined;
        return c.json(await deps.threads!.getThread(principal, threadId, cursor));
      } catch (err: unknown) {
        return mapThreadRouteError(c, err);
      }
    });

    app.post("/threads/:threadId/abort", threadAbortBodyLimit, async (c) => {
      try {
        const principal = principalFor(c);
        const threadId = ThreadIdSchema.parse(c.req.param("threadId"));
        const body = AbortThreadBodySchema.parse(await c.req.json());
        return c.json(await deps.threads!.abortThread(principal, threadId, body.clientRequestId));
      } catch (err: unknown) {
        return mapThreadRouteError(c, err);
      }
    });
  }

  return app;
}
