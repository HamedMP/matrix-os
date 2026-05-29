import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod/v4";
import { mapActivationError } from "./activation-errors.js";
import type { DraftActionReadinessService } from "./draft-action-readiness.js";
import {
  requireRequestPrincipal,
  type RequestPrincipal,
} from "../request-principal.js";

const DRAFT_ACTION_BODY_LIMIT = 16 * 1024;

const DraftCreateRequestSchema = z.object({
  type: z.enum(["support_reply", "social_post", "acquisition_message", "customer_follow_up"]),
  content: z.string().trim().min(1).max(5000),
  destination: z.string().trim().min(1).max(220),
  createdByAgent: z.enum(["claude", "codex", "hermes"]),
}).strict();

const DraftApprovalRequestSchema = z.object({
  approved: z.boolean(),
}).strict();

const DraftParamsSchema = z.object({
  draftId: z.string().trim().min(2).max(120).regex(/^draft\.[a-z0-9-]+$/),
});

export interface DraftActionRouteDeps {
  service: DraftActionReadinessService;
  getPrincipal?: (c: Context) => RequestPrincipal;
}

function jsonError(c: Context, err: unknown) {
  const mapped = mapActivationError(err);
  return c.json(mapped.body, mapped.status as ContentfulStatusCode);
}

export function createDraftActionRoutes(deps: DraftActionRouteDeps): Hono {
  const app = new Hono();
  const limited = bodyLimit({ maxSize: DRAFT_ACTION_BODY_LIMIT });
  const principalFor = (c: Context) => deps.getPrincipal?.(c) ?? requireRequestPrincipal(c);

  app.get("/readiness", async (c) => {
    try {
      const principal = principalFor(c);
      return c.json(await deps.service.getReadiness(principal.userId));
    } catch (err) {
      return jsonError(c, err);
    }
  });

  app.post("/drafts", limited, async (c) => {
    try {
      const principal = principalFor(c);
      const body = DraftCreateRequestSchema.parse(await c.req.json());
      return c.json(await deps.service.createDraft(principal.userId, body));
    } catch (err) {
      return jsonError(c, err);
    }
  });

  app.post("/drafts/:draftId/approval", limited, async (c) => {
    try {
      const principal = principalFor(c);
      const { draftId } = DraftParamsSchema.parse({ draftId: c.req.param("draftId") });
      const body = DraftApprovalRequestSchema.parse(await c.req.json());
      return c.json(await deps.service.approveDraft(principal.userId, draftId, body.approved));
    } catch (err) {
      return jsonError(c, err);
    }
  });

  return app;
}
