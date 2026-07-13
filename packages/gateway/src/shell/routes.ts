import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
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

interface SessionRegistryRoutes {
  list(): Promise<unknown[]>;
  get?(name: string): Promise<unknown>;
  create(input: {
    name: string;
    cwd?: string;
    layout?: string;
    cmd?: string;
  }): Promise<unknown>;
  delete(name: string, options?: { force?: boolean }): Promise<void>;
  rename?(name: string, nextName: string): Promise<unknown>;
  reorder?(order: string[]): Promise<unknown[]>;
  updateUiState?(name: string, input: {
    placement?: "active" | "background";
    lastSeenSeq?: number | null;
    visualStatus?: "running" | "finished" | "idle" | "waiting";
  }): Promise<unknown>;
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
});
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
  visualStatus: z.enum(["running", "finished", "idle", "waiting"]).optional(),
}).strict().refine((value) => Object.keys(value).length > 0);
const SessionRenameBodySchema = z.object({
  name: NewSessionNameSchema,
}).strict();
const SessionOrderBodySchema = z.object({
  order: z.array(SafeSessionNameSchema).max(100),
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
      return c.json({ sessions: await deps.registry.list() });
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
      const session = await deps.registry.create(body);
      const name =
        typeof session === "object" && session !== null && "name" in session
          ? String((session as { name: unknown }).name)
          : body.name;
      return c.json({ name, created: true }, 201);
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
      await deps.registry.delete(SafeSessionNameSchema.parse(c.req.param("name")), {
        force: new URL(c.req.url).searchParams.get("force") === "1",
      });
      return c.json({ ok: true });
    } catch (err) {
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
      const session = await deps.registry.updateUiState(
        SafeSessionNameSchema.parse(c.req.param("name")),
        body,
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
      const current = await deps.preferences.loadGlobal();
      const preferences = await deps.preferences.saveGlobal({
        ...current,
        ...(await c.req.json()),
      });
      if (deps.shellThemeConfig) {
        await deps.shellThemeConfig.setShellTheme(preferences.shellThemeId);
      }
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
