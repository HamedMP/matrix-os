/** Extracted verbatim from packages/gateway/src/collaboration/routes.ts (S01 / T008). */
import {
  CollaborationAiRequestControlSchema,
  CollaborationAiRequestsResponseSchema,
  CollaborationApprovalDecisionRequestSchema,
  CollaborationCreateAiRequestSchema,
  CollaborationCreateDiscussionRequestSchema,
  CollaborationDiscussionUserStatePatchSchema,
  CollaborationIdSchema,
  CollaborationResourceIdSchema,
  CollaborationUserStatePatchSchema,
} from "@matrix-os/contracts";
import type { Hono } from "hono";
import {
  authorize,
  requireExecutionAdapter,
  readJson,
  requireChatContext,
  exactQuery,
  handle,
  MessageQuerySchema,
  type CollaborationRouteOptions,
} from "./route-support.js";

export function registerChatRoutes(routes: Hono, options: CollaborationRouteOptions): void {
  routes.get("/api/collaboration/scopes/:scopeId/user-state", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const context = await authorize(options, c, new Uint8Array(), "read", scopeId);
    requireChatContext(context);
    return c.json(await options.chatAdapter.getUserState(context));
  }));

  routes.patch("/api/collaboration/scopes/:scopeId/user-state", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const { value, bytes } = await readJson(c);
    const context = await authorize(options, c, bytes, "read", scopeId);
    requireChatContext(context);
    const input = CollaborationUserStatePatchSchema.parse(value);
    return c.json(await options.chatAdapter.updateUserState(context, input));
  }));

  routes.get("/api/collaboration/scopes/:scopeId/chat", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const context = await authorize(options, c, new Uint8Array(), "read", scopeId);
    return c.json(await options.chatAdapter.getChat(context));
  }));

  routes.get("/api/collaboration/scopes/:scopeId/chat/messages", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const context = await authorize(options, c, new Uint8Array(), "read", scopeId);
    const query = MessageQuerySchema.parse(exactQuery(c, ["after", "limit"]));
    return c.json({
      messages: await options.chatAdapter.listMessages(context, {
        afterSequence: query.after,
        limit: query.limit,
      }),
    });
  }));

  routes.post("/api/collaboration/scopes/:scopeId/chat/messages", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const { value, bytes } = await readJson(c);
    const context = await authorize(options, c, bytes, "discuss", scopeId);
    const input = CollaborationCreateDiscussionRequestSchema.parse(value);
    return c.json(await options.chatAdapter.appendDiscussion(context, input), 201);
  }));

  routes.get("/api/collaboration/scopes/:scopeId/discussion/messages", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const context = await authorize(options, c, new Uint8Array(), "read", scopeId);
    const query = MessageQuerySchema.parse(exactQuery(c, ["after", "limit"]));
    return c.json(await options.discussionAdapter.list(context, {
      afterSequence: query.after,
      limit: query.limit,
    }));
  }));

  routes.post("/api/collaboration/scopes/:scopeId/discussion/messages", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const { value, bytes } = await readJson(c);
    const context = await authorize(options, c, bytes, "discuss", scopeId);
    const input = CollaborationCreateDiscussionRequestSchema.parse(value);
    return c.json(await options.discussionAdapter.append(context, input), 201);
  }));

  routes.get("/api/collaboration/scopes/:scopeId/discussion/user-state", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const context = await authorize(options, c, new Uint8Array(), "read", scopeId);
    return c.json(await options.discussionAdapter.getUserState(context));
  }));

  routes.patch("/api/collaboration/scopes/:scopeId/discussion/user-state", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const { value, bytes } = await readJson(c);
    const context = await authorize(options, c, bytes, "read", scopeId);
    const input = CollaborationDiscussionUserStatePatchSchema.parse(value);
    return c.json(await options.discussionAdapter.updateUserState(context, input));
  }));

  routes.get("/api/collaboration/scopes/:scopeId/chat/requests", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const adapter = requireExecutionAdapter(options.chatExecutionAdapter);
    const context = await authorize(options, c, new Uint8Array(), "read", scopeId, "m2");
    const requests = await adapter.list(context);
    return c.json(CollaborationAiRequestsResponseSchema.parse({
      requests,
      ...await adapter.capability(context, requests),
      resourceRevision: await adapter.resourceRevision(context),
    }));
  }));

  routes.post("/api/collaboration/scopes/:scopeId/chat/requests", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const adapter = requireExecutionAdapter(options.chatExecutionAdapter);
    const { value, bytes } = await readJson(c);
    const context = await authorize(options, c, bytes, "request_ai", scopeId, "m2");
    return c.json(await adapter.submit(context, CollaborationCreateAiRequestSchema.parse(value)), 201);
  }));

  routes.post("/api/collaboration/scopes/:scopeId/chat/requests/:requestId/cancel", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const requestId = CollaborationResourceIdSchema.parse(c.req.param("requestId"));
    const adapter = requireExecutionAdapter(options.chatExecutionAdapter);
    const { value, bytes } = await readJson(c);
    const context = await authorize(options, c, bytes, "control_execution", scopeId, "m2");
    return c.json(await adapter.cancel(context, requestId, CollaborationAiRequestControlSchema.parse(value)));
  }));

  routes.post("/api/collaboration/scopes/:scopeId/chat/requests/:requestId/retry", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const requestId = CollaborationResourceIdSchema.parse(c.req.param("requestId"));
    const adapter = requireExecutionAdapter(options.chatExecutionAdapter);
    const { value, bytes } = await readJson(c);
    const context = await authorize(options, c, bytes, "control_execution", scopeId, "m2");
    return c.json(await adapter.retry(context, requestId, CollaborationAiRequestControlSchema.parse(value)), 201);
  }));

  routes.post("/api/collaboration/scopes/:scopeId/chat/approvals/:approvalId/decision", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const approvalId = CollaborationResourceIdSchema.parse(c.req.param("approvalId"));
    const adapter = requireExecutionAdapter(options.chatExecutionAdapter);
    const { value, bytes } = await readJson(c);
    const context = await authorize(options, c, bytes, "control_execution", scopeId, "m2");
    return c.json(await adapter.decideApproval(
      context,
      approvalId,
      CollaborationApprovalDecisionRequestSchema.parse(value),
    ));
  }));
}
