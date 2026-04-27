import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { toShellError } from "./errors.js";
import {
  ShellPreferencesSchema,
  type ShellPreferencesStore,
} from "./preferences.js";

interface SessionRegistryRoutes {
  list(): Promise<unknown[]>;
  create(input: {
    name: string;
    cwd?: string;
    layout?: string;
    cmd?: string;
  }): Promise<unknown>;
  delete(name: string, options?: { force?: boolean }): Promise<void>;
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

export interface ShellRouteDeps {
  registry: SessionRegistryRoutes;
  preferences?: ShellPreferencesStore;
  workspace?: ShellWorkspaceRoutes;
  layouts?: ShellLayoutRoutes;
}

const CreateSessionBodySchema = z.object({
  name: z.string().min(1).max(64),
  cwd: z.string().min(1).max(1024).optional(),
  layout: z.string().min(1).max(64).optional(),
  cmd: z.string().min(1).max(4096).optional(),
});
const SafeNameSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/);
const SafeCwdSchema = z.string().min(1).max(1024).refine((value) => !value.startsWith("/"));
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

export function createShellRoutes(deps: ShellRouteDeps): Hono {
  const app = new Hono();
  const sessionBodyLimit = bodyLimit({ maxSize: 4096 });
  const preferencesBodyLimit = bodyLimit({ maxSize: 4096 });
  const workspaceBodyLimit = bodyLimit({ maxSize: 8192 });
  const layoutBodyLimit = bodyLimit({ maxSize: 128_000 });

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

  app.delete("/sessions/:name", async (c) => {
    try {
      await deps.registry.delete(c.req.param("name"), {
        force: new URL(c.req.url).searchParams.get("force") === "1",
      });
      return c.json({ ok: true });
    } catch (err) {
      return safeError(c, err);
    }
  });

  app.get("/sessions/:name/tabs", async (c) => {
    try {
      if (!deps.workspace) return unavailable(c, "workspace_unavailable");
      return c.json({ tabs: await deps.workspace.listTabs(c.req.param("name")) });
    } catch (err) {
      return safeError(c, err);
    }
  });

  app.post("/sessions/:name/tabs", workspaceBodyLimit, async (c) => {
    try {
      if (!deps.workspace) return unavailable(c, "workspace_unavailable");
      const body = TabBodySchema.parse(await c.req.json());
      return c.json({ tab: await deps.workspace.createTab(c.req.param("name"), body) });
    } catch (err) {
      return safeError(c, err);
    }
  });

  app.post("/sessions/:name/tabs/:tab/go", async (c) => {
    try {
      if (!deps.workspace) return unavailable(c, "workspace_unavailable");
      const tab = z.coerce.number().int().nonnegative().parse(c.req.param("tab"));
      await deps.workspace.switchTab(c.req.param("name"), tab);
      return c.json({ ok: true });
    } catch (err) {
      return safeError(c, err);
    }
  });

  app.delete("/sessions/:name/tabs/:tab", async (c) => {
    try {
      if (!deps.workspace) return unavailable(c, "workspace_unavailable");
      const tab = z.coerce.number().int().nonnegative().parse(c.req.param("tab"));
      await deps.workspace.closeTab(c.req.param("name"), tab);
      return c.json({ ok: true });
    } catch (err) {
      return safeError(c, err);
    }
  });

  app.post("/sessions/:name/panes", workspaceBodyLimit, async (c) => {
    try {
      if (!deps.workspace) return unavailable(c, "workspace_unavailable");
      const body = PaneBodySchema.parse(await c.req.json());
      return c.json({ pane: await deps.workspace.splitPane(c.req.param("name"), body) });
    } catch (err) {
      return safeError(c, err);
    }
  });

  app.delete("/sessions/:name/panes/:pane", async (c) => {
    try {
      if (!deps.workspace) return unavailable(c, "workspace_unavailable");
      await deps.workspace.closePane(c.req.param("name"), SafeNameSchema.parse(c.req.param("pane")));
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
      return c.json({ layout: await deps.layouts.show(c.req.param("name")) });
    } catch (err) {
      return safeError(c, err);
    }
  });

  app.put("/layouts/:name", layoutBodyLimit, async (c) => {
    try {
      if (!deps.layouts) return unavailable(c, "layouts_unavailable");
      const body = LayoutBodySchema.parse(await c.req.json());
      await deps.layouts.save(c.req.param("name"), body.kdl);
      return c.json({ ok: true });
    } catch (err) {
      return safeError(c, err);
    }
  });

  app.delete("/layouts/:name", async (c) => {
    try {
      if (!deps.layouts) return unavailable(c, "layouts_unavailable");
      await deps.layouts.delete(c.req.param("name"));
      return c.json({ ok: true });
    } catch (err) {
      return safeError(c, err);
    }
  });

  app.post("/sessions/:name/layouts/:layout/apply", async (c) => {
    try {
      if (!deps.workspace) return unavailable(c, "workspace_unavailable");
      await deps.workspace.applyLayout(c.req.param("name"), c.req.param("layout"));
      return c.json({ ok: true });
    } catch (err) {
      return safeError(c, err);
    }
  });

  app.get("/sessions/:name/layout/dump", async (c) => {
    try {
      if (!deps.workspace) return unavailable(c, "workspace_unavailable");
      return c.json({ layout: await deps.workspace.dumpLayout(c.req.param("name")) });
    } catch (err) {
      return safeError(c, err);
    }
  });

  app.get("/sessions/:name/preferences", async (c) => {
    try {
      if (!deps.preferences) {
        return c.json({ preferences: ShellPreferencesSchema.parse({}) });
      }
      return c.json({ preferences: await deps.preferences.load(c.req.param("name")) });
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
        c.req.param("name"),
        ShellPreferencesSchema.parse(await c.req.json()),
      );
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

function safeError(c: Context, err: unknown) {
  if (err instanceof z.ZodError) {
    return c.json(
      { error: { code: "invalid_request", message: "Invalid request" } },
      400,
    );
  }
  const shellErr = toShellError(err);
  console.warn("[shell] route failed:", err instanceof Error ? err.message : String(err));
  return c.json(
    { error: { code: shellErr.code, message: shellErr.safeMessage } },
    (shellErr.status ?? 500) as 500,
  );
}
