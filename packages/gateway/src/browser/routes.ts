import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod/v4";
import { bodyLimit } from "hono/body-limit";
import { BrowserService, toBrowserSafeError } from "./service.js";
import { InMemoryBrowserRepository, type BrowserAuditEventType } from "./repository.js";
import { BrowserHandoffReplayStore, verifyBrowserHandoffToken } from "../handoff-token.js";
import type { BrowserStreamHub } from "./ws.js";

const profileNameSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/);

const sessionCreateSchema = z.object({
  profileName: profileNameSchema.default("default"),
  targetUrl: z.string().max(2048).optional(),
  handoffToken: z.string().max(4096).optional(),
  surface: z.enum(["canvas", "standalone"]),
  deviceId: z.string().min(1).max(128),
});

const profileClearSchema = z.object({
  scopes: z.array(z.enum([
    "cookies",
    "localStorage",
    "sessionStorage",
    "indexedDb",
    "cache",
    "serviceWorkers",
    "sitePermissions",
    "savedFormData",
    "savedPasswords",
    "history",
    "downloads",
  ])).min(1).max(16),
});

const grantCreateSchema = z.object({
  sessionId: z.string().min(1).max(128),
  scopes: z.array(z.enum(["read_dom", "screenshot", "navigate", "download", "automate_input"])).min(1).max(8),
  domains: z.array(z.string().min(1).max(253)).min(1).max(32),
  expiresAt: z.string().datetime().optional(),
});

const closeSessionSchema = z.object({
  reason: z.enum(["user", "idle", "recoverable"]).default("user"),
});

const takeoverSessionSchema = z.object({
  deviceId: z.string().min(1).max(128),
  confirm: z.literal(true),
});

const tabCreateSchema = z.object({
  targetUrl: z.string().min(1).max(2048),
});

const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(256).optional(),
  type: z.enum([
    "session.created",
    "session.closed",
    "session.idle_hibernated",
    "session.taken_over",
    "navigation.attempted",
    "navigation.blocked",
    "download.started",
    "download.completed",
    "download.failed",
    "profile.cleared",
    "permission.granted",
    "permission.revoked",
    "agent.access",
  ]).optional(),
});

export interface BrowserRoutesOptions {
  getOwnerId?: (c: Context) => string;
  service?: BrowserService;
  handoffPublicKey?: string;
  handoffReplayStore?: BrowserHandoffReplayStore;
  streamHub?: BrowserStreamHub;
}

export function createBrowserRoutes(opts: BrowserRoutesOptions = {}) {
  const app = new Hono();
  const service = opts.service ?? new BrowserService({ repo: new InMemoryBrowserRepository() });
  const handoffReplayStore = opts.handoffReplayStore ?? new BrowserHandoffReplayStore();

  app.get("/capability", (c) => c.json(service.capability()));

  app.get("/sessions", async (c) => {
    const ownerId = opts.getOwnerId?.(c) ?? "local-owner";
    return c.json({ sessions: await service.listSessions({ ownerId }) });
  });

  app.post("/sessions", bodyLimit({ maxSize: 16 * 1024 }), async (c) => {
    try {
      const ownerId = opts.getOwnerId?.(c) ?? "local-owner";
      const input = sessionCreateSchema.parse(await c.req.json());
      let targetUrl = input.targetUrl;
      if (input.handoffToken) {
        const publicKey = opts.handoffPublicKey ?? process.env.BROWSER_HANDOFF_PUBLIC_KEY;
        if (!publicKey) {
          return c.json({ error: { code: "handoff_unavailable", message: "Browser request is invalid." } }, 400);
        }
        const claims = await verifyBrowserHandoffToken({
          token: input.handoffToken,
          publicKey,
          expectedOwnerId: ownerId,
          replayStore: handoffReplayStore,
        });
        targetUrl = claims.target;
      }
      return c.json(await service.createSession({ ownerId, ...input, targetUrl }));
    } catch (error) {
      const safe = toBrowserSafeError(error);
      return c.json(
        { error: { code: safe.code, message: safe.message } },
        safe.code === "payload_too_large" ? 413 : 400,
      );
    }
  });

  app.post("/sessions/:sessionId/close", bodyLimit({ maxSize: 4 * 1024 }), async (c) => {
    try {
      const ownerId = opts.getOwnerId?.(c) ?? "local-owner";
      const sessionId = z.string().min(1).max(128).parse(c.req.param("sessionId"));
      const input = closeSessionSchema.parse(await c.req.json());
      const state = input.reason === "idle" ? "hibernated" : input.reason === "recoverable" ? "recoverable" : "closed";
      return c.json({ session: await service.closeSession({ ownerId, sessionId, state }) });
    } catch (error) {
      const safe = toBrowserSafeError(error);
      return c.json({ error: { code: safe.code, message: safe.message } }, safe.code === "payload_too_large" ? 413 : 400);
    }
  });

  app.post("/sessions/:sessionId/takeover", bodyLimit({ maxSize: 4 * 1024 }), async (c) => {
    try {
      const ownerId = opts.getOwnerId?.(c) ?? "local-owner";
      const sessionId = z.string().min(1).max(128).parse(c.req.param("sessionId"));
      const input = takeoverSessionSchema.parse(await c.req.json());
      const result = await service.takeoverSession({ ownerId, sessionId, deviceId: input.deviceId });
      opts.streamHub?.notifySessionTakenOver(sessionId);
      return c.json(result);
    } catch (error) {
      const safe = toBrowserSafeError(error);
      return c.json({ error: { code: safe.code, message: safe.message } }, safe.code === "payload_too_large" ? 413 : 400);
    }
  });

  app.get("/sessions/:sessionId/tabs", async (c) => {
    try {
      const ownerId = opts.getOwnerId?.(c) ?? "local-owner";
      const sessionId = z.string().min(1).max(128).parse(c.req.param("sessionId"));
      return c.json({ tabs: await service.listTabs({ ownerId, sessionId }) });
    } catch (error) {
      const safe = toBrowserSafeError(error);
      return c.json({ error: { code: safe.code, message: safe.message } }, 400);
    }
  });

  app.post("/sessions/:sessionId/tabs", bodyLimit({ maxSize: 16 * 1024 }), async (c) => {
    try {
      const ownerId = opts.getOwnerId?.(c) ?? "local-owner";
      const sessionId = z.string().min(1).max(128).parse(c.req.param("sessionId"));
      const input = tabCreateSchema.parse(await c.req.json());
      return c.json({
        tab: await service.upsertTab({
          ownerId,
          sessionId,
          url: input.targetUrl,
        }),
      });
    } catch (error) {
      const safe = toBrowserSafeError(error);
      return c.json({ error: { code: safe.code, message: safe.message } }, safe.code === "payload_too_large" ? 413 : 400);
    }
  });

  app.post("/profiles/:profileName/clear", bodyLimit({ maxSize: 16 * 1024 }), async (c) => {
    try {
      const ownerId = opts.getOwnerId?.(c) ?? "local-owner";
      const profileName = profileNameSchema.parse(c.req.param("profileName"));
      const input = profileClearSchema.parse(await c.req.json());
      return c.json({
        profile: await service.clearProfile({ ownerId, profileName, scopes: input.scopes }),
      });
    } catch (error) {
      const safe = toBrowserSafeError(error);
      return c.json({ error: { code: safe.code, message: safe.message } }, 400);
    }
  });

  app.get("/downloads", async (c) => {
    const ownerId = opts.getOwnerId?.(c) ?? "local-owner";
    return c.json({ downloads: await service.listDownloads({ ownerId }) });
  });

  app.delete("/downloads/:downloadId", bodyLimit({ maxSize: 1024 }), async (c) => {
    try {
      const ownerId = opts.getOwnerId?.(c) ?? "local-owner";
      const downloadId = z.string().min(1).max(128).parse(c.req.param("downloadId"));
      const download = await service.deleteDownload({ ownerId, downloadId });
      return c.json({ download });
    } catch (error) {
      const safe = toBrowserSafeError(error);
      return c.json({ error: { code: safe.code, message: safe.message } }, 400);
    }
  });

  app.get("/audit", async (c) => {
    try {
      const ownerId = opts.getOwnerId?.(c) ?? "local-owner";
      const input = auditQuerySchema.parse({
        limit: c.req.query("limit"),
        cursor: c.req.query("cursor"),
        type: c.req.query("type"),
      });
      return c.json(await service.listAudit({
        ownerId,
        limit: input.limit,
        cursor: input.cursor,
        eventType: input.type as BrowserAuditEventType | undefined,
      }));
    } catch (error) {
      const safe = toBrowserSafeError(error);
      return c.json({ error: { code: safe.code, message: safe.message } }, 400);
    }
  });

  app.get("/grants", async (c) => {
    const ownerId = opts.getOwnerId?.(c) ?? "local-owner";
    return c.json({ grants: await service.listActiveGrants({ ownerId }) });
  });

  app.post("/grants", bodyLimit({ maxSize: 16 * 1024 }), async (c) => {
    try {
      const ownerId = opts.getOwnerId?.(c) ?? "local-owner";
      const input = grantCreateSchema.parse(await c.req.json());
      return c.json({
        grant: await service.createGrant({ ownerId, ...input }),
      });
    } catch (error) {
      const safe = toBrowserSafeError(error);
      return c.json({ error: { code: safe.code, message: safe.message } }, 400);
    }
  });

  app.delete("/grants/:grantId", bodyLimit({ maxSize: 1024 }), async (c) => {
    try {
      const ownerId = opts.getOwnerId?.(c) ?? "local-owner";
      const grantId = z.string().min(1).max(128).parse(c.req.param("grantId"));
      const grant = await service.revokeGrant({ ownerId, grantId });
      return c.json({ grant });
    } catch (error) {
      const safe = toBrowserSafeError(error);
      return c.json({ error: { code: safe.code, message: safe.message } }, 400);
    }
  });

  return app;
}
