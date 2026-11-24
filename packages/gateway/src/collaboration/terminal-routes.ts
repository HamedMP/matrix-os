/** Extracted verbatim from packages/gateway/src/collaboration/routes.ts (S01 / T008). */
import {
  CollaborationIdSchema,
  CollaborationTeamTerminalActionSchema,
  TeamTerminalLabelRequestSchema,
  TeamTerminalProjectionSchema,
} from "@matrix-os/contracts";
import { CollaborationAuthorizationError } from "./authority.js";
import { readTeamTerminalLabel, writeTeamTerminalLabel } from "./team-terminal-labels.js";
import type { Hono } from "hono";
import {
  authorize,
  requireTerminalDispatcher,
  readJson,
  handle,
  type CollaborationRouteOptions,
} from "./route-support.js";
import { CollaborationTerminalControlSettingSchema } from "./terminal-dispatcher.js";

export function registerTerminalRoutes(routes: Hono, options: CollaborationRouteOptions): void {
  routes.get("/api/collaboration/scopes/:scopeId/terminal", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const context = await authorize(options, c, new Uint8Array(), "read", scopeId);
    return c.json(await requireTerminalDispatcher(options.terminalDispatcher).read(context));
  }));

  routes.post("/api/collaboration/scopes/:scopeId/terminal/actions", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const { value, bytes } = await readJson(c);
    const action = CollaborationTeamTerminalActionSchema.parse(value);
    const context = await authorize(options, c, bytes, "control_execution", scopeId);
    const connectionId = "connectionId" in action ? action.connectionId : `http_${context.actorId}`;
    return c.json(await requireTerminalDispatcher(options.terminalDispatcher).dispatch({
      scopeId,
      actorId: context.actorId,
      connectionId,
      action,
    }));
  }));

  // Spec 2710: what a member's Team section shows, hydrated from this (owner) computer.
  routes.get("/api/collaboration/scopes/:scopeId/terminal/team", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const context = await authorize(options, c, new Uint8Array(), "read", scopeId);
    const dispatcher = requireTerminalDispatcher(options.terminalDispatcher);
    const terminal = await dispatcher.read(context);
    const [owner, computerLabel, terminalName] = await Promise.all([
      options.resolveParticipant(context.ownerId).catch((error: unknown) => {
        console.warn("[collaboration-terminal] owner lookup failed", error instanceof Error ? error.name : "UnknownError");
        return { actorId: context.ownerId, displayName: "Organization member" };
      }),
      readTeamTerminalLabel(options.repository.db, scopeId),
      options.teamTerminalName ? options.teamTerminalName(context.resourceId) : Promise.resolve(null),
    ]);
    return c.json(TeamTerminalProjectionSchema.parse({
      scopeId,
      incarnation: terminal.incarnation,
      // A tab name that is not safe display text falls back rather than failing the projection.
      terminalName: TeamTerminalProjectionSchema.shape.terminalName.safeParse(terminalName).data ?? "Terminal",
      ...(computerLabel ? { computerLabel } : {}),
      owner: owner.actorId === context.ownerId ? owner : { actorId: context.ownerId, displayName: "Organization member" },
      role: context.role,
      status: terminal.status,
      inputMode: dispatcher.inputMode(scopeId, terminal.incarnation),
    }));
  }));

  routes.put("/api/collaboration/scopes/:scopeId/terminal/team/label", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const { value, bytes } = await readJson(c);
    const input = TeamTerminalLabelRequestSchema.parse(value);
    const context = await authorize(options, c, bytes, "manage_members", scopeId);
    if (context.role !== "owner" || context.resourceKind !== "terminal") {
      throw new CollaborationAuthorizationError("forbidden", "Owner terminal access is required");
    }
    await writeTeamTerminalLabel(options.repository.db, { scopeId, computerLabel: input.computerLabel.trim(), now: (options.now ?? (() => new Date()))() });
    return c.json({ scopeId, computerLabel: input.computerLabel.trim() });
  }));

  // S07 review: the owner's explicit opt-in (or withdrawal) for Contributor control of a shared host shell.
  routes.patch("/api/collaboration/scopes/:scopeId/terminal", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const { value, bytes } = await readJson(c);
    const setting = CollaborationTerminalControlSettingSchema.parse(value);
    const context = await authorize(options, c, bytes, "manage_members", scopeId);
    return c.json(await requireTerminalDispatcher(options.terminalDispatcher).setContributorControl(context, setting));
  }));
}
