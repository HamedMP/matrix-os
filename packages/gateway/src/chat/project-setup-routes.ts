import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { CanonicalChatIdSchema, ProjectIdSchema, ProjectSetupResponseSchema, ProjectSetupStartRequestSchema, ProjectSetupUpdateRequestSchema } from "@matrix-os/contracts";
import type { RequestPrincipal } from "../request-principal.js";
import { isRequestPrincipalError, mapRequestPrincipalError } from "../request-principal.js";
import { ChatExecutionRootError } from "./execution-root.js";
import { ProjectSetupError } from "./project-setup-state.js";
import type { ProjectSetupService } from "./project-setup-service.js";

type SetupRouteService = Pick<ProjectSetupService, "getProject" | "start" | "getChat" | "update">;

function failed(context: Context, error: unknown) {
  if (isRequestPrincipalError(error)) {
    const mapped = mapRequestPrincipalError(error);
    return context.json(mapped.body, mapped.status);
  }
  if (error instanceof z.ZodError || error instanceof SyntaxError) return context.json({ error: "Invalid project setup request" }, 400);
  if (error instanceof ProjectSetupError) {
    if (error.kind === "not_found") return context.json({ error: "Project setup not found" }, 404);
    if (error.kind === "conflict" || error.kind === "busy") return context.json({ error: "Project setup changed. Refresh and review it again." }, 409);
    if (error.kind === "invalid") return context.json({ error: "Invalid project setup request" }, 400);
  }
  if (error instanceof ChatExecutionRootError && error.code !== "validation_unavailable") return context.json({ error: "Project setup not found" }, 404);
  console.warn("[project-setup] Request unavailable:", error instanceof Error ? error.name : "UnknownError");
  return context.json({ error: "Project setup is temporarily unavailable" }, 503);
}

export function createProjectSetupRoutes(options: { service: SetupRouteService | null; getPrincipal: (context: Context) => RequestPrincipal }): Hono {
  const routes = new Hono();
  const limit = bodyLimit({ maxSize: 192 * 1024, onError: c => c.json({ error: "Project setup request is too large" }, 413) });
  const authenticated = (context: Context) => {
    const principal = options.getPrincipal(context);
    if (!options.service) throw new ProjectSetupError("unavailable");
    return { principal, owner: { type: "personal" as const, ownerId: principal.userId }, service: options.service };
  };
  routes.get("/api/projects/:projectId/setup", async context => {
    context.header("Cache-Control", "no-store");
    try {
      const { owner, service } = authenticated(context);
      const projectId = ProjectIdSchema.parse(context.req.param("projectId"));
      return context.json(ProjectSetupResponseSchema.parse(await service.getProject(owner, projectId)));
    } catch (error: unknown) { return failed(context, error); }
  });
  routes.post("/api/projects/:projectId/setup", limit, async context => {
    context.header("Cache-Control", "no-store");
    try {
      const { owner, service } = authenticated(context);
      const projectId = ProjectIdSchema.parse(context.req.param("projectId"));
      const input = ProjectSetupStartRequestSchema.parse(await context.req.json());
      return context.json(ProjectSetupResponseSchema.parse(await service.start(owner, projectId, input)), 201);
    } catch (error: unknown) { return failed(context, error); }
  });
  routes.get("/api/chats/:chatId/project-setup", async context => {
    context.header("Cache-Control", "no-store");
    try {
      const { owner, service } = authenticated(context);
      const chatId = CanonicalChatIdSchema.parse(context.req.param("chatId"));
      return context.json(ProjectSetupResponseSchema.parse(await service.getChat(owner, chatId)));
    } catch (error: unknown) { return failed(context, error); }
  });
  routes.patch("/api/chats/:chatId/project-setup", limit, async context => {
    context.header("Cache-Control", "no-store");
    try {
      const { principal, owner, service } = authenticated(context);
      const chatId = CanonicalChatIdSchema.parse(context.req.param("chatId"));
      const input = ProjectSetupUpdateRequestSchema.parse(await context.req.json());
      return context.json(ProjectSetupResponseSchema.parse(await service.update(principal, owner, chatId, input)));
    } catch (error: unknown) { return failed(context, error); }
  });
  return routes;
}
