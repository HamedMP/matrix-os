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

export interface ShellRouteDeps {
  registry: SessionRegistryRoutes;
  preferences?: ShellPreferencesStore;
}

const CreateSessionBodySchema = z.object({
  name: z.string().min(1).max(64),
  cwd: z.string().min(1).max(1024).optional(),
  layout: z.string().min(1).max(64).optional(),
  cmd: z.string().min(1).max(4096).optional(),
});

export function createShellRoutes(deps: ShellRouteDeps): Hono {
  const app = new Hono();
  const sessionBodyLimit = bodyLimit({ maxSize: 4096 });
  const preferencesBodyLimit = bodyLimit({ maxSize: 4096 });

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
