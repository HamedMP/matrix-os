import { bodyLimit } from "hono/body-limit";
import { Hono } from "hono";
import {
  CanonicalChatIdSchema,
  ProjectIdSchema,
  SafeDisplayStringSchema,
  TerminalRefSchema,
  TerminalTabIdSchema,
  TerminalWorkspaceIdSchema,
  type TerminalTab,
  type TerminalWorkspace,
} from "@matrix-os/contracts";
import type { Context } from "hono";
import type { RequestPrincipal } from "../request-principal.js";
import { z } from "zod/v4";
import { saveTerminalPasteAsset } from "./paste-assets.js";

const EnsureWorkspaceSchema = z.object({ projectId: ProjectIdSchema.optional() }).strict();
const CreateTabSchema = z.object({
  name: SafeDisplayStringSchema,
  cwd: z.string().max(4096),
  command: z.array(z.string().min(1).max(4096)).min(1).max(128).optional(),
  chatId: CanonicalChatIdSchema.optional(),
}).strict();
const RenameTabSchema = z.object({
  name: SafeDisplayStringSchema,
  baseRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();
const ReorderTabsSchema = z.object({
  tabIds: z.array(TerminalTabIdSchema).max(10_000),
  baseRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();
const UiStateSchema = z.object({
  placement: z.enum(["active", "background"]).optional(),
  lastSeenSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  baseRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();
const DeleteWorkspaceSchema = z.object({ confirmTerminate: z.boolean() }).strict();
const PasteAssetsSchema = z.object({
  assets: z.array(z.object({
    name: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(120),
    dataBase64: z.string().min(1).max(8 * 1024 * 1024),
  }).strict()).min(1).max(20),
}).strict();

export interface TerminalWorkspaceRouteRuntime {
  listWorkspaces(): Promise<TerminalWorkspace[]>;
  ensureWorkspace(input?: { projectId?: string }): Promise<TerminalWorkspace>;
  createTab(workspaceId: string, input: { name: string; cwd: string; command?: string[] }): Promise<TerminalTab>;
  renameTab?(ref: { workspaceId: string; tabId: string }, input: { name: string; baseRevision: number }): Promise<TerminalTab>;
  reorderTabs?(workspaceId: string, input: { tabIds: string[]; baseRevision: number }): Promise<TerminalWorkspace>;
  terminateTab?(ref: { workspaceId: string; tabId: string }): Promise<void>;
  updateTabUiState?(ref: { workspaceId: string; tabId: string }, input: z.infer<typeof UiStateSchema>): Promise<TerminalTab>;
  deletionImpact(workspaceId: string): Promise<{ runningTabs: number; tabs: TerminalTab[] }>;
  deleteWorkspace(workspaceId: string, input: { confirmTerminate: true }): Promise<void>;
}

export function createTerminalWorkspaceRoutes(options: {
  runtime: TerminalWorkspaceRouteRuntime;
  homePath?: string;
  getPrincipal?: (context: Context) => RequestPrincipal;
  chatTerminals?: {
    prepare(principal: RequestPrincipal, chatId: string): Promise<{ runId?: string; cwd?: string }>;
    bind(principal: RequestPrincipal, input: {
      chatId: string;
      runId?: string;
      sessionId: string;
      sessionCreatedAt: string;
    }): Promise<void>;
  };
}): Hono {
  const app = new Hono();
  const mutationLimit = bodyLimit({ maxSize: 16 * 1024 });
  const deleteLimit = bodyLimit({ maxSize: 1024 });
  const pasteLimit = bodyLimit({ maxSize: 10 * 1024 * 1024 });

  app.get("/workspaces", async (c) => {
    try { return c.json({ workspaces: await options.runtime.listWorkspaces() }); }
    catch (error) { return runtimeFailure(c, error); }
  });

  app.post("/workspaces/ensure", mutationLimit, async (c) => {
    try {
      const body = EnsureWorkspaceSchema.parse(await c.req.json());
      return c.json({ workspace: await options.runtime.ensureWorkspace(body) });
    } catch (error) { return requestFailure(c, error); }
  });

  app.post("/workspaces/:workspaceId/tabs", mutationLimit, async (c) => {
    try {
      const workspaceId = TerminalWorkspaceIdSchema.parse(c.req.param("workspaceId"));
      const body = CreateTabSchema.parse(await c.req.json());
      const principal = body.chatId ? options.getPrincipal?.(c) : undefined;
      if (body.chatId && (!principal || !options.chatTerminals)) {
        throw new Error("Chat terminal dependencies are unavailable");
      }
      const binding = body.chatId && principal && options.chatTerminals
        ? await options.chatTerminals.prepare(principal, body.chatId)
        : null;
      const tab = await options.runtime.createTab(workspaceId, {
        name: body.name,
        cwd: binding?.cwd ?? body.cwd,
        ...(body.command ? { command: body.command } : {}),
      });
      if (body.chatId && principal && binding && options.chatTerminals) {
        try {
          await options.chatTerminals.bind(principal, {
            chatId: body.chatId,
            ...(binding.runId ? { runId: binding.runId } : {}),
            sessionId: `${workspaceId}:${tab.id}`,
            sessionCreatedAt: tab.createdAt,
          });
        } catch (error: unknown) {
          try { await options.runtime.terminateTab?.({ workspaceId, tabId: tab.id }); }
          catch (cleanupError: unknown) { console.error("[gateway] Chat terminal cleanup failed", cleanupError); }
          throw error;
        }
      }
      return c.json({ tab }, 201);
    } catch (error) { return requestFailure(c, error); }
  });

  app.patch("/workspaces/:workspaceId/tabs/:tabId", mutationLimit, async (c) => {
    try {
      if (!options.runtime.renameTab) return c.json({ error: "Terminal operation unavailable" }, 503);
      const ref = terminalRefFromParams(c.req.param("workspaceId"), c.req.param("tabId"));
      return c.json({ tab: await options.runtime.renameTab(ref, RenameTabSchema.parse(await c.req.json())) });
    } catch (error) { return requestFailure(c, error); }
  });

  app.put("/workspaces/:workspaceId/tabs/order", mutationLimit, async (c) => {
    try {
      if (!options.runtime.reorderTabs) return c.json({ error: "Terminal operation unavailable" }, 503);
      const workspaceId = TerminalWorkspaceIdSchema.parse(c.req.param("workspaceId"));
      return c.json({ workspace: await options.runtime.reorderTabs(workspaceId, ReorderTabsSchema.parse(await c.req.json())) });
    } catch (error) { return requestFailure(c, error); }
  });

  app.delete("/workspaces/:workspaceId/tabs/:tabId", deleteLimit, async (c) => {
    try {
      if (!options.runtime.terminateTab) return c.json({ error: "Terminal operation unavailable" }, 503);
      await options.runtime.terminateTab(terminalRefFromParams(c.req.param("workspaceId"), c.req.param("tabId")));
      return c.body(null, 204);
    } catch (error) { return requestFailure(c, error); }
  });

  app.patch("/workspaces/:workspaceId/tabs/:tabId/ui-state", mutationLimit, async (c) => {
    try {
      if (!options.runtime.updateTabUiState) return c.json({ error: "Terminal operation unavailable" }, 503);
      const ref = terminalRefFromParams(c.req.param("workspaceId"), c.req.param("tabId"));
      return c.json({ tab: await options.runtime.updateTabUiState(ref, UiStateSchema.parse(await c.req.json())) });
    } catch (error) { return requestFailure(c, error); }
  });

  app.post("/workspaces/:workspaceId/tabs/:tabId/paste-assets", pasteLimit, async (c) => {
    try {
      if (!options.homePath) return c.json({ error: "Terminal operation unavailable" }, 503);
      const ref = terminalRefFromParams(c.req.param("workspaceId"), c.req.param("tabId"));
      const input = PasteAssetsSchema.parse(await c.req.json());
      const workspace = (await options.runtime.listWorkspaces()).find((candidate) => candidate.id === ref.workspaceId);
      const tab = workspace?.tabs.find((candidate) => candidate.id === ref.tabId);
      if (!tab) return c.json({ error: "Terminal operation failed" }, 404);
      const assets = [];
      for (const asset of input.assets) {
        const bytes = decodeBase64(asset.dataBase64);
        assets.push(await saveTerminalPasteAsset({
          homePath: options.homePath,
          cwd: tab.cwd,
          bytes,
          contentType: asset.mimeType,
          filename: asset.name,
        }));
      }
      return c.json({ assets });
    } catch (error) { return requestFailure(c, error); }
  });

  app.get("/workspaces/:workspaceId/deletion-impact", async (c) => {
    try {
      const workspaceId = TerminalWorkspaceIdSchema.parse(c.req.param("workspaceId"));
      return c.json(await options.runtime.deletionImpact(workspaceId));
    } catch (error) { return requestFailure(c, error); }
  });

  app.delete("/workspaces/:workspaceId", deleteLimit, async (c) => {
    try {
      const workspaceId = TerminalWorkspaceIdSchema.parse(c.req.param("workspaceId"));
      const body = DeleteWorkspaceSchema.parse(await c.req.json());
      const impact = await options.runtime.deletionImpact(workspaceId);
      if (impact.runningTabs > 0 && !body.confirmTerminate) {
        return c.json({ error: "terminal_termination_confirmation_required", ...impact }, 409);
      }
      await options.runtime.deleteWorkspace(workspaceId, { confirmTerminate: true });
      return c.body(null, 204);
    } catch (error) { return requestFailure(c, error); }
  });

  return app;
}

function decodeBase64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 === 1) {
    throw new z.ZodError([{ code: "custom", path: ["dataBase64"], message: "Invalid base64" }]);
  }
  return Buffer.from(value, "base64");
}

function terminalRefFromParams(workspaceId: string, tabId: string) {
  return TerminalRefSchema.parse({ workspaceId, tabId });
}

function requestFailure(c: Parameters<typeof runtimeFailure>[0], error: unknown) {
  if (error instanceof Error && error.name === "BodyLimitError") {
    return c.json({ error: "Request body is too large" }, 413);
  }
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return c.json({ error: "Invalid request" }, 400);
  }
  return runtimeFailure(c, error);
}

function runtimeFailure(c: { json: (body: { error: string }, status: 400 | 413 | 500) => Response }, error: unknown) {
  console.error("[gateway] terminal workspace request failed", error);
  return c.json({ error: "Terminal operation failed" }, 500);
}
