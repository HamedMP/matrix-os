/** Extracted verbatim from packages/gateway/src/collaboration/routes.ts (S01 / T008). */
import {
  CollaborationIdSchema,
  CollaborationTeamTerminalActionSchema,
  TeamComputerShareRequestSchema,
  TeamComputerShareSchema,
  TeamComputerTabCreatedSchema,
  TeamTerminalLabelRequestSchema,
  TeamTerminalProjectionSchema,
} from "@matrix-os/contracts";
import { TeamComputerShareError } from "./team-computer-share.js";
import { CollaborationAuthorizationError } from "./authority.js";
import { readTeamTerminalLabel, writeTeamTerminalLabel } from "./team-terminal-labels.js";
import type { Hono } from "hono";
import { z } from "zod/v4";
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
    const [owner, computerLabel, info] = await Promise.all([
      options.resolveParticipant(context.ownerId).catch((error: unknown) => {
        console.warn("[collaboration-terminal] owner lookup failed", error instanceof Error ? error.name : "UnknownError");
        return { actorId: context.ownerId, displayName: "Organization member" };
      }),
      readTeamTerminalLabel(options.repository.db, scopeId),
      options.teamTerminalInfo ? options.teamTerminalInfo(context.resourceId) : Promise.resolve(null),
    ]);
    return c.json(TeamTerminalProjectionSchema.parse({
      scopeId,
      incarnation: terminal.incarnation,
      // A tab name that is not safe display text falls back rather than failing the projection.
      terminalName: TeamTerminalProjectionSchema.shape.terminalName.safeParse(info?.name).data ?? "Terminal",
      ...(computerLabel ? { computerLabel } : {}),
      owner: owner.actorId === context.ownerId ? owner : { actorId: context.ownerId, displayName: "Organization member" },
      role: context.role,
      status: terminal.status,
      inputMode: dispatcher.inputMode(scopeId, terminal.incarnation),
      ...(await computerAccess(options, scopeId, context.role)),
      ...(TeamTerminalProjectionSchema.shape.size.safeParse(info?.size).data ? { size: info!.size } : {}),
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

  // Spec 2710 layer 6: whole-computer sharing, reached through any of its terminals' scopes.
  routes.get("/api/collaboration/scopes/:scopeId/terminal/team/computer", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const context = await authorize(options, c, new Uint8Array(), "read", scopeId);
    const computers = requireTeamComputers(options);
    const policy = await computers.policy();
    const shared = Boolean(policy) && (context.role === "owner" || await computers.isComputerScope(scopeId));
    return c.json(TeamComputerShareSchema.parse({
      shared,
      ...(context.role === "owner" && policy ? { grants: policy.grants } : {}),
      canOpenTabs: shared && context.role !== "viewer",
    }));
  }));

  routes.put("/api/collaboration/scopes/:scopeId/terminal/team/computer", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const { value, bytes } = await readJson(c);
    const input = TeamComputerShareRequestSchema.parse(value);
    const context = await authorize(options, c, bytes, "manage_members", scopeId);
    if (context.role !== "owner" || context.resourceKind !== "terminal") {
      throw new CollaborationAuthorizationError("forbidden", "Owner terminal access is required");
    }
    const computers = requireTeamComputers(options);
    const computerLabel = await readTeamTerminalLabel(options.repository.db, scopeId) ?? "Computer";
    const shared = await computers.share({ organizationId: context.organizationId, computerLabel, grants: input.grants });
    return c.json({ shared: true, terminals: shared });
  }));

  routes.delete("/api/collaboration/scopes/:scopeId/terminal/team/computer", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const context = await authorize(options, c, new Uint8Array(), "manage_members", scopeId);
    if (context.role !== "owner") throw new CollaborationAuthorizationError("forbidden", "Owner terminal access is required");
    await requireTeamComputers(options).stop();
    return c.json({ shared: false });
  }));

  routes.post("/api/collaboration/scopes/:scopeId/terminal/team/tabs", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const { value, bytes } = await readJson(c);
    z.object({}).strict().parse(value);
    // Opening a tab is shell access: the same authority as typing (no viewers).
    const context = await authorize(options, c, bytes, "control_execution", scopeId);
    const computers = requireTeamComputers(options);
    if (context.role === "viewer" || (context.role !== "owner" && !await computers.isComputerScope(scopeId))) {
      throw new CollaborationAuthorizationError("forbidden", "Shared computer access is required");
    }
    try {
      return c.json(TeamComputerTabCreatedSchema.parse({ scopeId: await computers.openTab(context.actorId) }), 201);
    } catch (error: unknown) {
      if (error instanceof TeamComputerShareError) {
        // Too many new tabs reads as unavailable: the client waits and tries again.
        throw new CollaborationAuthorizationError(error.code === "forbidden" ? "forbidden" : "unavailable", "Shared computer is unavailable");
      }
      throw error;
    }
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

function requireTeamComputers(options: CollaborationRouteOptions) {
  if (!options.teamComputers) throw new CollaborationAuthorizationError("unavailable", "Shared computers are unavailable");
  return options.teamComputers;
}

async function computerAccess(options: CollaborationRouteOptions, scopeId: string, role: string): Promise<{ computerShared?: boolean; canOpenTabs?: boolean }> {
  if (!options.teamComputers) return {};
  const computerShared = await options.teamComputers.isComputerScope(scopeId);
  return computerShared ? { computerShared, canOpenTabs: role !== "viewer" } : {};
}
