import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { CanonicalChatIdSchema } from "@matrix-os/contracts";
import { createRateLimiter, type RateLimiter } from "../security/rate-limiter.js";
import { toShellError } from "./errors.js";
import { SESSION_NAME_PATTERN } from "./names.js";
import {
  saveTerminalPasteAsset,
  TERMINAL_PASTE_ASSET_BODY_LIMIT,
} from "./paste-assets.js";
import {
  ShellPreferencesSchema,
  type ShellThemeId,
  type ShellPreferencesStore,
} from "./preferences.js";
import type { ShellCommandRunner } from "./command-runner.js";
import { AgentKindSchema, type AgentKind } from "./agent-session-state.js";
import type { RequestPrincipal } from "../request-principal.js";

interface SessionRegistryRoutes {
  list(): Promise<unknown[]>;
  get?(name: string): Promise<unknown>;
  create(input: {
    name: string;
    cwd?: string;
    layout?: string;
    cmd?: string;
    agent?: AgentKind;
    exclusive?: boolean;
  }): Promise<unknown>;
  recover?(name: string, input: { cwd?: string }): Promise<unknown>;
  delete(name: string, options?: { force?: boolean }): Promise<void>;
  rename?(name: string, nextName: string): Promise<unknown>;
  reorder?(order: string[]): Promise<unknown[]>;
  updateUiState?(name: string, input: {
    placement?: "active" | "background";
    lastSeenSeq?: number | null;
    visualStatus?: "running" | "finished" | "idle" | "waiting";
  }): Promise<unknown>;
}

interface ShellSessionLifecycleRoutes {
  withSessionLifecycleLock<T>(name: string, operation: () => Promise<T>): Promise<T>;
  beginSessionDeletion(name: string): Promise<void>;
  completeSessionDeletion(name: string): Promise<void>;
  deleteSessionReferences(name: string): Promise<void>;
  clearSessionTombstone(name: string): Promise<void>;
  listSessionTombstones(): Promise<string[]>;
}

interface ChatTerminalRoutes {
  prepare(principal: RequestPrincipal, chatId: string): Promise<{ runId?: string; cwd?: string }>;
  bind(principal: RequestPrincipal, input: {
    chatId: string;
    runId?: string;
    sessionId: string;
    sessionCreatedAt: string;
  }): Promise<void>;
}

interface ShellWorkspaceRoutes {
  listTabs(name: string): Promise<unknown[]>;
  createTab(name: string, input: { name?: string; cwd?: string; cmd?: string }): Promise<unknown>;
  switchTab(name: string, tab: number): Promise<unknown>;
  closeTab(name: string, tab: number): Promise<unknown>;
  splitPane(name: string, input: { direction: "right" | "down"; cwd?: string; cmd?: string }): Promise<unknown>;
  closePane(name: string, pane: string): Promise<unknown>;
  applyLayout(name: string, layout: string): Promise<unknown>;
  dumpLayout(name: string): Promise<unknown>;
}

interface ShellLayoutRoutes {
  list(): Promise<unknown[]>;
  show(name: string): Promise<unknown>;
  save(name: string, kdl: string): Promise<void>;
  delete(name: string): Promise<void>;
}

interface ShellBackendHealthRoutes {
  health(): Promise<{ ok: boolean; code: "ok" | "zellij_failed" }>;
}

interface ShellSessionDiagnosticSummary {
  ok: true;
  total: number;
  active: number;
  background: number;
  unread: number;
  waiting: number;
  exited: number;
}

interface ShellSessionDiagnosticFailure {
  ok: false;
  code: "session_list_unavailable";
}

interface ShellThemeConfigRoutes {
  setShellTheme(themeId: ShellThemeId): Promise<void>;
}

interface TerminalInputRoutes {
  sendInput(name: string, data: string): Promise<void>;
}

export interface ShellRouteDeps {
  homePath?: string;
  registry: SessionRegistryRoutes;
  preferences?: ShellPreferencesStore;
  workspace?: ShellWorkspaceRoutes;
  layouts?: ShellLayoutRoutes;
  shellBackend?: ShellBackendHealthRoutes;
  shellThemeConfig?: ShellThemeConfigRoutes;
  commandRunner?: ShellCommandRunner;
  terminalInput?: TerminalInputRoutes;
  sessionCreateRateLimiter?: RateLimiter;
  sessionLifecycle?: ShellSessionLifecycleRoutes;
  getPrincipal?: (c: Context) => RequestPrincipal;
  listChatBoundSessionIds?: (
    principal: RequestPrincipal,
    sessionIds: readonly string[],
  ) => Promise<readonly string[]>;
  chatTerminals?: ChatTerminalRoutes;
}

export const SHELL_SESSION_CREATE_RATE_LIMIT = {
  maxAttempts: 120,
  windowMs: 60_000,
  lockoutMs: 10_000,
  maxKeys: 1,
};

const NewSessionNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,30}$/);
const CreateSessionBodySchema = z.object({
  name: NewSessionNameSchema,
  cwd: safeCwdSchema().optional(),
  layout: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).optional(),
  cmd: z.string().min(1).max(4096).optional(),
  agent: AgentKindSchema.optional(),
  chatId: CanonicalChatIdSchema.optional(),
}).strict().refine((input) => input.chatId === undefined || (
  input.cwd === undefined
  && input.layout === undefined
  && input.cmd === undefined
  && input.agent === undefined
), { message: "Chat terminals use their server-resolved workspace" });
const SafeNameSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/);
const SafeSessionNameSchema = z.string().regex(SESSION_NAME_PATTERN);
const SafeLayoutNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const SafeCwdSchema = safeCwdSchema();
const TabBodySchema = z.object({
  name: SafeNameSchema.optional(),
  cwd: SafeCwdSchema.optional(),
  cmd: z.string().min(1).max(4096).optional(),
});
const PaneBodySchema = z.object({
  direction: z.enum(["right", "down"]),
  cwd: SafeCwdSchema.optional(),
  cmd: z.string().min(1).max(4096).optional(),
});
const LayoutBodySchema = z.object({
  kdl: z.string().min(1).max(100_000),
});
const RunBodySchema = z.object({
  command: z.array(z.string().min(1).max(4096)).min(1).max(64),
  cwd: SafeCwdSchema.optional(),
  timeoutMs: z.number().int().positive().max(30 * 60 * 1000).optional(),
});
const TerminalInputBodySchema = z.object({
  data: z.string().min(1).max(65_536),
}).strict();
const PasteAssetQuerySchema = z.object({
  cwd: SafeCwdSchema.default("projects"),
}).strict();
const SessionUiStateBodySchema = z.object({
  placement: z.enum(["active", "background"]).optional(),
  lastSeenSeq: z.number().int().nonnegative().nullable().optional(),
  pinned: z.boolean().optional(),
  visualStatus: z.enum(["running", "finished", "idle", "waiting"]).optional(),
}).strict().refine((value) => Object.keys(value).length > 0);
const SessionRenameBodySchema = z.object({
  name: NewSessionNameSchema,
}).strict();
const SessionOrderBodySchema = z.object({
  order: z.array(SafeSessionNameSchema).max(100),
}).strict();
const RecoverSessionBodySchema = z.object({
  cwd: safeCwdSchema().optional(),
}).strict();

function safeCwdSchema() {
  return z.string().min(1).max(1024)
    .refine((value) => !value.startsWith("/"))
    .refine((value) => !value.split(/[\\/]+/).includes(".."));
}

export function createShellRoutes(deps: ShellRouteDeps): Hono {
  const app = new Hono();
  const sessionCreateRateLimiter =
    deps.sessionCreateRateLimiter ?? createRateLimiter(SHELL_SESSION_CREATE_RATE_LIMIT);
  const sessionBodyLimit = bodyLimit({ maxSize: 4096 });
  const sessionRenameBodyLimit = bodyLimit({ maxSize: 1024 });
  const sessionOrderBodyLimit = bodyLimit({ maxSize: 8192 });
  const uiStateBodyLimit = bodyLimit({ maxSize: 1024 });
  const preferencesBodyLimit = bodyLimit({ maxSize: 4096 });
  const workspaceBodyLimit = bodyLimit({ maxSize: 8192 });
  const layoutBodyLimit = bodyLimit({ maxSize: 128_000 });
  const deleteBodyLimit = bodyLimit({ maxSize: 512 });
  const runBodyLimit = bodyLimit({ maxSize: 16_384 });
  const terminalInputBodyLimit = bodyLimit({ maxSize: 70_000 });
  const terminalPasteAssetBodyLimit = bodyLimit({
    maxSize: TERMINAL_PASTE_ASSET_BODY_LIMIT,
    onError: bodyTooLarge,
  });

  const withSessionLifecycleLock = <T>(name: string, operation: () => Promise<T>): Promise<T> => (
    deps.sessionLifecycle
      ? deps.sessionLifecycle.withSessionLifecycleLock(name, operation)
      : operation()
  );

  const rollbackCreatedSession = async (name: string, restoreTombstone: boolean): Promise<void> => {
    let runtimeCleanupError: unknown;
    try {
      await deps.registry.delete(name, { force: true });
    } catch (cleanupError: unknown) {
      runtimeCleanupError = cleanupError;
      console.error(
        "[shell] Created terminal session cleanup failed:",
        cleanupError instanceof Error ? cleanupError.name : "UnknownError",
      );
    }

    let tombstoneCleanupError: unknown;
    if ((restoreTombstone || runtimeCleanupError !== undefined) && deps.sessionLifecycle) {
      try {
        await deps.sessionLifecycle.deleteSessionReferences(name);
      } catch (cleanupError: unknown) {
        tombstoneCleanupError = cleanupError;
        console.error(
          "[shell] Terminal session tombstone restoration failed:",
          cleanupError instanceof Error ? cleanupError.name : "UnknownError",
        );
      }
    }

    if (runtimeCleanupError !== undefined || tombstoneCleanupError !== undefined) {
      throw new Error("Terminal session creation rollback failed", {
        cause: tombstoneCleanupError ?? runtimeCleanupError,
      });
    }
  };

  const commitCreatedSession = async (name: string): Promise<void> => {
    if (!deps.sessionLifecycle) return;
    try {
      await deps.sessionLifecycle.clearSessionTombstone(name);
    } catch (error: unknown) {
      try {
        await rollbackCreatedSession(name, false);
      } catch (rollbackError: unknown) {
        throw new Error("Terminal session creation could not be committed or rolled back", {
          cause: rollbackError,
        });
      }
      throw error;
    }
  };

  const commitRecoveredSession = async (name: string): Promise<void> => {
    await deps.sessionLifecycle?.clearSessionTombstone(name);
  };

  app.get("/health", async (c) => {
    if (!deps.shellBackend) {
      console.warn("[shell] shell health route missing backend dependency");
      return c.json({ shell: { ok: false, code: "shell_backend_unavailable" } }, 503);
    }
    try {
      const health = await deps.shellBackend.health();
      if (new URL(c.req.url).searchParams.get("include") === "sessions") {
        try {
          const sessions = await deps.registry.list();
          return c.json({
            shell: {
              ...health,
              sessions: summarizeShellSessionDiagnostics(sessions),
            },
          }, health.ok ? 200 : 503);
        } catch (err: unknown) {
          console.warn(
            "[shell] terminal session diagnostics failed:",
            err instanceof Error ? err.message : String(err),
          );
          return c.json({
            shell: {
              ...health,
              sessions: {
                ok: false,
                code: "session_list_unavailable",
              } satisfies ShellSessionDiagnosticFailure,
            },
          }, health.ok ? 200 : 503);
        }
      }
      return c.json({ shell: health }, health.ok ? 200 : 503);
    } catch (err: unknown) {
      console.warn("[shell] shell health check failed:", err instanceof Error ? err.message : String(err));
      return c.json({ shell: { ok: false, code: "zellij_failed" } }, 503);
    }
  });

  app.get("/sessions", async (c) => {
    try {
      let sessions = await deps.registry.list();
      if (deps.sessionLifecycle) {
        const tombstoned = await deps.sessionLifecycle.listSessionTombstones();
        sessions = sessions.filter((session) => (
          !session || typeof session !== "object" || !("name" in session)
          || typeof (session as { name?: unknown }).name !== "string"
          || !tombstoned.includes((session as { name: string }).name)
        ));
      }
      if (!deps.listChatBoundSessionIds) return c.json({ sessions });
      if (!deps.getPrincipal) throw new Error("Missing shell principal dependency");
      const visible: unknown[] = [];
      for (let start = 0; start < sessions.length; start += 100) {
        const chunk = sessions.slice(start, start + 100);
        const names = chunk.flatMap((session) => (
          session && typeof session === "object" && "name" in session
            && typeof (session as { name?: unknown }).name === "string"
            ? [(session as { name: string }).name]
            : []
        ));
        const boundIds = await deps.listChatBoundSessionIds(deps.getPrincipal(c), names);
        const bound = new Set(boundIds.slice(0, 100));
        visible.push(...chunk.filter((session) => (
          !session || typeof session !== "object" || !("name" in session)
          || typeof (session as { name?: unknown }).name !== "string"
          || !bound.has((session as { name: string }).name)
        )));
      }
      return c.json({ sessions: visible });
    } catch (err) {
      return safeError(c, err);
    }
  });

  app.post("/sessions", sessionBodyLimit, async (c) => {
    try {
      const body = CreateSessionBodySchema.parse(await c.req.json());
      if (!sessionCreateRateLimiter.check("shell-session-create")) {
        return c.json(
          { error: { code: "rate_limited", message: "Request failed" } },
          429,
          { "Retry-After": String(Math.ceil(SHELL_SESSION_CREATE_RATE_LIMIT.lockoutMs / 1000)) },
        );
      }
      const principal = body.chatId ? deps.getPrincipal?.(c) : undefined;
      if (body.chatId && (!principal || !deps.chatTerminals)) {
        throw new Error("Chat terminal dependencies are unavailable");
      }
      const binding = body.chatId && principal && deps.chatTerminals
        ? await deps.chatTerminals.prepare(principal, body.chatId)
        : null;
      const sessionInput = {
        name: body.name,
        ...(body.chatId ? { exclusive: true } : {}),
        ...(binding?.cwd ? { cwd: binding.cwd } : body.cwd ? { cwd: body.cwd } : {}),
        ...(body.layout ? { layout: body.layout } : {}),
        ...(body.cmd ? { cmd: body.cmd } : {}),
        ...(body.agent ? { agent: body.agent } : {}),
      };
      return await withSessionLifecycleLock(body.name, async () => {
        const session = await deps.registry.create(sessionInput);
        const name =
          typeof session === "object" && session !== null && "name" in session
            ? String((session as { name: unknown }).name)
            : body.name;
        await commitCreatedSession(name);
        const sessionCreatedAt =
          typeof session === "object" && session !== null && "createdAt" in session
            ? z.iso.datetime().parse((session as { createdAt: unknown }).createdAt)
            : null;
        if (body.chatId && principal && binding && deps.chatTerminals) {
          try {
            if (!sessionCreatedAt) throw new Error("Chat terminal session incarnation unavailable");
            await deps.chatTerminals.bind(principal, {
              chatId: body.chatId,
              ...(binding.runId ? { runId: binding.runId } : {}),
              sessionId: name,
              sessionCreatedAt,
            });
          } catch (error: unknown) {
            await rollbackCreatedSession(name, true);
            throw error;
          }
        }
        return c.json({ name, created: true }, 201);
      });
    } catch (err) {
      return safeError(c, err);
    }
  });

  app.put("/sessions/order", sessionOrderBodyLimit, async (c) => {
    try {
      if (!deps.registry.reorder) return unavailable(c, "session_reorder_unavailable");
      const body = SessionOrderBodySchema.parse(await c.req.json());
      return c.json({ sessions: await deps.registry.reorder(body.order) });
    } catch (err) {
      return safeError(c, err);
    }
  });

  app.delete("/sessions/:name", deleteBodyLimit, async (c) => {
    try {
      const name = SafeSessionNameSchema.parse(c.req.param("name"));
      const sessionLifecycle = deps.sessionLifecycle;
      if (!sessionLifecycle) throw new Error("Missing terminal session lifecycle dependency");
      console.info("[terminal-lifecycle]", { event: "terminal.session.delete.requested", name });
      return await sessionLifecycle.withSessionLifecycleLock(name, async () => {
        await sessionLifecycle.beginSessionDeletion(name);
        await deps.registry.delete(name, {
          force: new URL(c.req.url).searchParams.get("force") === "1",
        });
        await sessionLifecycle.completeSessionDeletion(name);
        console.info("[terminal-lifecycle]", { event: "terminal.session.delete.completed", name });
        return c.json({ ok: true });
      });
    } catch (err) {
      console.warn("[terminal-lifecycle]", {
        event: "terminal.session.delete.failed",
        error: err instanceof Error ? err.name : "UnknownError",
      });
      return safeError(c, err);
    }
  });

  app.post("/sessions/:name/recover", sessionBodyLimit, async (c) => {
    try {
      const name = SafeSessionNameSchema.parse(c.req.param("name"));
      const body = RecoverSessionBodySchema.parse(await c.req.json());
      if (!sessionCreateRateLimiter.check("shell-session-create")) {
        return c.json(
          { error: { code: "rate_limited", message: "Request failed" } },
          429,
          { "Retry-After": String(Math.ceil(SHELL_SESSION_CREATE_RATE_LIMIT.lockoutMs / 1000)) },
        );
      }
      if (!deps.registry.recover) return unavailable(c, "session_recovery_unavailable");
      console.info("[terminal-lifecycle]", { event: "terminal.session.recover.requested", name });
      return await withSessionLifecycleLock(name, async () => {
        const session = await deps.registry.recover!(name, body.cwd ? { cwd: body.cwd } : {});
        await commitRecoveredSession(name);
        console.info("[terminal-lifecycle]", { event: "terminal.session.recover.completed", name });
        return c.json({ session }, 201);
      });
    } catch (err: unknown) {
      console.warn("[terminal-lifecycle]", {
        event: "terminal.session.recover.failed",
        error: err instanceof Error ? err.name : "UnknownError",
      });
      return safeError(c, err);
    }
  });

  const renameSessionHandler = async (c: Context) => {
    try {
      if (!deps.registry.rename) return unavailable(c, "session_rename_unavailable");
      const body = SessionRenameBodySchema.parse(await c.req.json());
      const session = await deps.registry.rename(
        SafeSessionNameSchema.parse(c.req.param("name")),
        body.name,
      );
      return c.json({ session });
    } catch (err) {
      return safeError(c, err);
    }
  };

  app.put("/sessions/:name/rename", sessionRenameBodyLimit, renameSessionHandler);
  app.patch("/sessions/:name", sessionRenameBodyLimit, renameSessionHandler);

  app.patch("/sessions/:name/ui-state", uiStateBodyLimit, async (c) => {
    try {
      if (!deps.registry.updateUiState) return unavailable(c, "session_ui_state_unavailable");
      const body = SessionUiStateBodySchema.parse(await c.req.json());
      const { visualStatus: _legacyVisualStatus, ...gatewayOwnedPatch } = body;
      const session = await deps.registry.updateUiState(
        SafeSessionNameSchema.parse(c.req.param("name")),
        gatewayOwnedPatch,
      );
      return c.json({ session });
    } catch (err) {
      return safeError(c, err);
    }
  });

  app.post("/run", runBodyLimit, async (c) => {
    try {
      if (!deps.commandRunner) return unavailable(c, "run_unavailable");
      const body = RunBodySchema.parse(await c.req.json());
      return c.json(await deps.commandRunner.run(body));
    } catch (err) {
      return safeError(c, err);
    }
  });

  app.post("/sessions/:name/input", terminalInputBodyLimit, async (c) => {
    try {
      if (!deps.terminalInput) return unavailable(c, "terminal_input_unavailable");
      const name = SafeSessionNameSchema.parse(c.req.param("name"));
      const body = TerminalInputBodySchema.parse(await c.req.json());
      await assertSessionExists(deps.registry, name);
      await deps.terminalInput.sendInput(name, body.data);
      return c.json({ ok: true });
    } catch (err) {
      return safeError(c, err);
    }
  });

  app.post("/sessions/:name/paste-assets", terminalPasteAssetBodyLimit, async (c) => {
    try {
      if (!deps.homePath) return unavailable(c, "paste_assets_unavailable");
      const name = SafeSessionNameSchema.parse(c.req.param("name"));
      const query = PasteAssetQuerySchema.parse({
        cwd: c.req.query("cwd") ?? "projects",
      });
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      if (bytes.byteLength > TERMINAL_PASTE_ASSET_BODY_LIMIT) {
        return c.json({ error: { code: "payload_too_large", message: "Request too large" } }, 413);
      }
      await assertSessionExists(deps.registry, name);
      const result = await saveTerminalPasteAsset({
        homePath: deps.homePath,
        cwd: query.cwd,
        contentType: c.req.header("Content-Type"),
        filename: c.req.header("X-Matrix-Filename"),
        bytes,
      });
      return c.json(result, 201);
    } catch (err) {
      return safeError(c, err);
    }
  });

  app.get("/sessions/:name/tabs", async (c) => {
    try {
      if (!deps.workspace) return unavailable(c, "workspace_unavailable");
      return c.json({ tabs: await deps.workspace.listTabs(SafeSessionNameSchema.parse(c.req.param("name"))) });
    } catch (err) {
      return safeError(c, err);
    }
  });

  app.post("/sessions/:name/tabs", workspaceBodyLimit, async (c) => {
    try {
      if (!deps.workspace) return unavailable(c, "workspace_unavailable");
      const body = TabBodySchema.parse(await c.req.json());
      return c.json({ tab: await deps.workspace.createTab(SafeSessionNameSchema.parse(c.req.param("name")), body) });
    } catch (err) {
      return safeError(c, err);
    }
  });

  app.post("/sessions/:name/tabs/:tab/go", async (c) => {
    try {
      if (!deps.workspace) return unavailable(c, "workspace_unavailable");
      const tab = z.coerce.number().int().nonnegative().parse(c.req.param("tab"));
      await deps.workspace.switchTab(SafeSessionNameSchema.parse(c.req.param("name")), tab);
      return c.json({ ok: true });
    } catch (err) {
      return safeError(c, err);
    }
  });

  app.delete("/sessions/:name/tabs/:tab", deleteBodyLimit, async (c) => {
    try {
      if (!deps.workspace) return unavailable(c, "workspace_unavailable");
      const tab = z.coerce.number().int().nonnegative().parse(c.req.param("tab"));
      await deps.workspace.closeTab(SafeSessionNameSchema.parse(c.req.param("name")), tab);
      return c.json({ ok: true });
    } catch (err) {
      return safeError(c, err);
    }
  });

  app.post("/sessions/:name/panes", workspaceBodyLimit, async (c) => {
    try {
      if (!deps.workspace) return unavailable(c, "workspace_unavailable");
      const body = PaneBodySchema.parse(await c.req.json());
      return c.json({ pane: await deps.workspace.splitPane(SafeSessionNameSchema.parse(c.req.param("name")), body) });
    } catch (err) {
      return safeError(c, err);
    }
  });

  app.delete("/sessions/:name/panes/:pane", deleteBodyLimit, async (c) => {
    try {
      if (!deps.workspace) return unavailable(c, "workspace_unavailable");
      await deps.workspace.closePane(SafeSessionNameSchema.parse(c.req.param("name")), SafeNameSchema.parse(c.req.param("pane")));
      return c.json({ ok: true });
    } catch (err) {
      return safeError(c, err);
    }
  });

  app.get("/layouts", async (c) => {
    try {
      if (!deps.layouts) return unavailable(c, "layouts_unavailable");
      return c.json({ layouts: await deps.layouts.list() });
    } catch (err) {
      return safeError(c, err);
    }
  });

  app.get("/layouts/:name", async (c) => {
    try {
      if (!deps.layouts) return unavailable(c, "layouts_unavailable");
      return c.json({ layout: await deps.layouts.show(SafeLayoutNameSchema.parse(c.req.param("name"))) });
    } catch (err) {
      return safeError(c, err);
    }
  });

  app.put("/layouts/:name", layoutBodyLimit, async (c) => {
    try {
      if (!deps.layouts) return unavailable(c, "layouts_unavailable");
      const body = LayoutBodySchema.parse(await c.req.json());
      await deps.layouts.save(SafeLayoutNameSchema.parse(c.req.param("name")), body.kdl);
      return c.json({ ok: true });
    } catch (err) {
      return safeError(c, err);
    }
  });

  app.delete("/layouts/:name", deleteBodyLimit, async (c) => {
    try {
      if (!deps.layouts) return unavailable(c, "layouts_unavailable");
      await deps.layouts.delete(SafeLayoutNameSchema.parse(c.req.param("name")));
      return c.json({ ok: true });
    } catch (err) {
      return safeError(c, err);
    }
  });

  app.post("/sessions/:name/layouts/:layout/apply", async (c) => {
    try {
      if (!deps.workspace) return unavailable(c, "workspace_unavailable");
      await deps.workspace.applyLayout(
        SafeSessionNameSchema.parse(c.req.param("name")),
        SafeLayoutNameSchema.parse(c.req.param("layout")),
      );
      return c.json({ ok: true });
    } catch (err) {
      return safeError(c, err);
    }
  });

  app.get("/sessions/:name/layout/dump", async (c) => {
    try {
      if (!deps.workspace) return unavailable(c, "workspace_unavailable");
      return c.json({ layout: await deps.workspace.dumpLayout(SafeSessionNameSchema.parse(c.req.param("name"))) });
    } catch (err) {
      return safeError(c, err);
    }
  });

  app.get("/sessions/:name/layout", async (c) => {
    try {
      if (!deps.workspace) return unavailable(c, "workspace_unavailable");
      return c.json({ layout: await deps.workspace.dumpLayout(SafeSessionNameSchema.parse(c.req.param("name"))) });
    } catch (err) {
      return safeError(c, err);
    }
  });

  app.get("/sessions/:name/preferences", async (c) => {
    try {
      if (!deps.preferences) {
        return c.json({ preferences: ShellPreferencesSchema.parse({}) });
      }
      return c.json({ preferences: await deps.preferences.load(SafeSessionNameSchema.parse(c.req.param("name"))) });
    } catch (err) {
      return safeError(c, err);
    }
  });

  app.get("/preferences", async (c) => {
    try {
      if (!deps.preferences) {
        return c.json({ preferences: ShellPreferencesSchema.parse({}) });
      }
      return c.json({ preferences: await deps.preferences.loadGlobal() });
    } catch (err) {
      return safeError(c, err);
    }
  });

  app.put("/preferences", preferencesBodyLimit, async (c) => {
    try {
      if (!deps.preferences) {
        return c.json(
          { error: { code: "preferences_unavailable", message: "Request failed" } },
          503,
        );
      }
      const shellThemeConfig = deps.shellThemeConfig;
      const preferences = await deps.preferences.updateGlobal(
        await c.req.json(),
        shellThemeConfig
          ? (next) => shellThemeConfig.setShellTheme(next.shellThemeId)
          : undefined,
      );
      return c.json({ preferences });
    } catch (err) {
      return safeError(c, err);
    }
  });

  app.put("/sessions/:name/preferences", preferencesBodyLimit, async (c) => {
    try {
      if (!deps.preferences) {
        return c.json(
          { error: { code: "preferences_unavailable", message: "Request failed" } },
          503,
        );
      }
      const preferences = await deps.preferences.save(
        SafeSessionNameSchema.parse(c.req.param("name")),
        ShellPreferencesSchema.parse(await c.req.json()),
      );
      if (deps.shellThemeConfig) {
        await deps.shellThemeConfig.setShellTheme(preferences.shellThemeId);
      }
      return c.json({ preferences });
    } catch (err) {
      return safeError(c, err);
    }
  });

  return app;
}

function unavailable(c: Context, code: string) {
  return c.json({ error: { code, message: "Request failed" } }, 503);
}

function bodyTooLarge(c: Context) {
  return c.json({ error: { code: "payload_too_large", message: "Request too large" } }, 413);
}

async function assertSessionExists(registry: SessionRegistryRoutes, name: string): Promise<void> {
  if (registry.get) {
    await registry.get(name);
    return;
  }
  const sessions = await registry.list();
  if (sessions.some((session) => (
    typeof session === "object" &&
    session !== null &&
    "name" in session &&
    (session as { name?: unknown }).name === name
  ))) {
    return;
  }
  throw toShellError(Object.assign(new Error("Session not found"), {
    code: "session_not_found",
    safeMessage: "Session not found",
    status: 404,
  }));
}

function safeError(c: Context, err: unknown) {
  if (hasHttpStatus(err, 413) || isBodyLimitError(err)) {
    return c.json(
      { error: { code: "payload_too_large", message: "Request too large" } },
      413,
    );
  }
  if (err instanceof z.ZodError) {
    return c.json(
      { error: { code: "invalid_request", message: "Invalid request" } },
      400,
    );
  }
  const shellErr = toShellError(err);
  if (shellErr.diagnostic) {
    console.warn("[shell] route failed:", {
      code: shellErr.code,
      diagnostic: shellErr.diagnostic,
      ...describeErrorForLog(shellErr),
    });
  } else {
    console.warn("[shell] route failed:", err instanceof Error ? err.message : String(err));
  }
  return c.json(
    { error: { code: shellErr.code, message: shellErr.safeMessage } },
    (shellErr.status ?? 500) as 500,
  );
}

function isBodyLimitError(err: unknown) {
  return err instanceof Error && err.name === "BodyLimitError";
}

function hasHttpStatus(err: unknown, status: number) {
  return (
    err instanceof Error &&
    "status" in err &&
    typeof (err as { status?: unknown }).status === "number" &&
    (err as { status: number }).status === status
  );
}

function describeErrorForLog(err: unknown) {
  if (!(err instanceof Error)) {
    return { message: String(err) };
  }
  const context: {
    message: string;
    cause?: string | { message: string; code?: string | number; signal?: string };
  } = { message: err.message };
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const causeContext: { message: string; code?: string | number; signal?: string } = {
      message: cause.message,
    };
    const code = (cause as NodeJS.ErrnoException).code;
    const signal = (cause as { signal?: unknown }).signal;
    if (typeof code === "string" || typeof code === "number") {
      causeContext.code = code;
    }
    if (typeof signal === "string") {
      causeContext.signal = signal;
    }
    context.cause = causeContext;
  } else if (cause !== undefined) {
    context.cause = String(cause);
  }
  return context;
}

function summarizeShellSessionDiagnostics(sessions: unknown[]): ShellSessionDiagnosticSummary {
  const summary: ShellSessionDiagnosticSummary = {
    ok: true,
    total: 0,
    active: 0,
    background: 0,
    unread: 0,
    waiting: 0,
    exited: 0,
  };
  for (const session of sessions) {
    if (!session || typeof session !== "object") {
      continue;
    }
    summary.total += 1;
    const candidate = session as {
      status?: unknown;
      placement?: unknown;
      unread?: unknown;
      visualStatus?: unknown;
    };
    if (candidate.status === "active") {
      summary.active += 1;
    }
    if (candidate.status === "exited") {
      summary.exited += 1;
    }
    if (candidate.placement === "background") {
      summary.background += 1;
    }
    if (candidate.unread === true) {
      summary.unread += 1;
    }
    if (candidate.visualStatus === "waiting") {
      summary.waiting += 1;
    }
  }
  return summary;
}
