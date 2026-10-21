import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import type { PlatformDb } from "../../platform-db.js";
import type { PipedreamConnectClient } from "../pipedream.js";
import type { VerifiedConnectedWebhookAdmission } from "../connected-webhook.js";
import type { IntegrationBroadcast } from "../routes.js";

export interface PipedreamGmailAttemptConfig { callbackUrl: string; environment: "production" | "development" }
const id = z.uuid();
const query = z.strictObject({ attempt: id, proof: z.string().regex(/^[a-f0-9]{64}$/) });
const base = { connect_token: z.string().regex(/^ctok_[a-f0-9]{32}$/), environment: z.enum(["production", "development"]) };
const callbackSchema = z.discriminatedUnion("event", [
  z.object({ ...base, event: z.literal("CONNECTION_SUCCESS"), account: z.object({ id: z.string().regex(/^apn_[A-Za-z0-9_-]{1,240}$/),
    external_id: z.string().min(1).max(256), healthy: z.literal(true), dead: z.boolean().nullable().optional(), app: z.object({ name_slug: z.literal("gmail") }) }) }),
  z.object({ ...base, event: z.literal("CONNECTION_ERROR") }),
]);
const connectSchema = z.object({ service: z.string(), label: z.string().trim().min(1).max(100).optional(), redirectUri: z.literal("matrixos://integrations").optional() });
const hash = (secret: string) => createHash("sha256").update(secret).digest("hex");
const matches = (secret: string, expected: string) => timingSafeEqual(Buffer.from(hash(secret), "hex"), Buffer.from(expected, "hex"));
const unavailable = { error: "Connection unavailable" };
class InvalidReceiptAccount extends Error {}

export function createPipedreamGmailAttemptRoutes(options: {
  db: PlatformDb; pipedream: PipedreamConnectClient; config: PipedreamGmailAttemptConfig;
  resolveUserId(c: Context): Promise<string | null>; admit?: VerifiedConnectedWebhookAdmission; emit: IntegrationBroadcast;
  isEligible(userId: string): Promise<boolean>;
}) {
  const app = new Hono(); const store = options.db.pipedreamGmailAttempts;
  if (!store || !options.pipedream.inspectAccount || !options.admit) throw new Error("Gmail connection receipts unavailable");
  // The shared native/legacy connect router applies bodyLimit before selecting either transport.
  app.post("/connect", async (c, next) => {
    let input: z.infer<typeof connectSchema>;
    try { input = connectSchema.parse(await c.req.json()); }
    catch (error) { if (!(error instanceof z.ZodError || error instanceof SyntaxError)) console.warn("[gmail-attempt] Invalid connection request"); return c.json(unavailable, 400); }
    if (input.service !== "gmail") return next();
    const userId = await options.resolveUserId(c); if (!userId) return c.json({ error: "Unauthorized" }, 401);
    try { if (!await options.isEligible(userId)) return next(); }
    catch (error) { console.warn('[gmail-attempt] Eligibility unavailable:', error instanceof Error ? error.name : 'UnknownError'); return c.json(unavailable, 503); }
    const attemptId = randomUUID(); const proof = randomBytes(32).toString("hex");
    try {
      const user = await options.db.getUserById(userId); if (!user) return c.json(unavailable, 503);
      const externalUserId = user.pipedream_external_id ?? userId;
      if (!user.pipedream_external_id) await options.db.updatePipedreamExternalId(userId, externalUserId);
      const now = new Date();
      await store.prepare({ id: attemptId, userId, externalUserId, environment: options.config.environment,
        nonceHash: hash(proof), label: input.label, now, expiresAt: new Date(now.getTime() + 600_000) });
      const callback = new URL(options.config.callbackUrl); callback.searchParams.set("attempt", attemptId); callback.searchParams.set("proof", proof);
      const issued = await options.pipedream.createConnectToken(externalUserId, { webhookUri: callback.href, expiresIn: 600,
        ...(input.redirectUri ? { successRedirectUri: input.redirectUri, errorRedirectUri: input.redirectUri } : {}) });
      if (!/^ctok_[a-f0-9]{32}$/.test(issued.token) || !Number.isFinite(Date.parse(issued.expiresAt)) || Date.parse(issued.expiresAt) <= Date.now()) throw new Error("Invalid connection response");
      const url = options.pipedream.getOAuthUrl(issued.connectLinkUrl, "gmail"); const target = new URL(url);
      if (target.protocol !== "https:" || target.username || target.password || target.hash
        || !(target.hostname === "pipedream.com" || target.hostname.endsWith(".pipedream.com"))
        || url.includes(proof) || decodeURIComponent(url).includes(proof)) throw new Error("Invalid connection response");
      await store.activate(attemptId, hash(issued.token), new Date(issued.expiresAt));
      c.header("Cache-Control", "no-store"); return c.json({ url, service: "gmail", attemptId });
    } catch (error) {
      await store.fail(attemptId).catch(failure => console.warn("[gmail-attempt] Cleanup failed:", failure instanceof Error ? failure.name : "UnknownError"));
      console.warn("[gmail-attempt] Start unavailable:", error instanceof Error ? error.name : "UnknownError"); return c.json(unavailable, 503);
    }
  });
  app.get("/gmail/pipedream/attempts/:attemptId", async c => {
    c.header("Cache-Control", "no-store");
    const userId = await options.resolveUserId(c); if (!userId) return c.json({ error: "Unauthorized" }, 401);
    const parsed = id.safeParse(c.req.param("attemptId")); if (!parsed.success) return c.json(unavailable, 400);
    try { const status = await store.status(parsed.data, userId); return status ? c.json(status) : c.json(unavailable, 404); }
    catch (error) { console.warn("[gmail-attempt] Status unavailable:", error instanceof Error ? error.name : "UnknownError"); return c.json(unavailable, 503); }
  });
  app.post("/gmail/pipedream/callback", bodyLimit({ maxSize: 64 * 1024 }), async c => {
    c.header("Cache-Control", "no-store");
    const parameters = new URL(c.req.url).searchParams;
    const parsedQuery = query.safeParse(Object.fromEntries(parameters));
    if (!parsedQuery.success || [...parameters].length !== 2) return c.json(unavailable, 400);
    try {
      const row = await store.inspect(parsedQuery.data.attempt);
      if (!row || !matches(parsedQuery.data.proof, row.nonceHash)) return c.json(unavailable, 403);
      let raw: unknown;
      try { raw = await c.req.json(); } catch (error) {
        if (error instanceof Error && error.name === "BodyLimitError") return c.json(unavailable, 413);
        if (!(error instanceof SyntaxError)) console.warn("[gmail-attempt] Invalid callback body");
        return c.json(unavailable, 400);
      }
      const body = callbackSchema.safeParse(raw); if (!body.success) return c.json(unavailable, 400);
      if (!row.tokenHash) return c.json(unavailable, 503);
      if (!matches(body.data.connect_token, row.tokenHash) || body.data.environment !== row.environment || row.environment !== options.config.environment) return c.json(unavailable, 403);
      if (row.status !== "pending" || row.expiresAt <= new Date()) return c.json({ ok: true });
      if (body.data.event === "CONNECTION_ERROR") { await store.fail(row.id); return c.json({ ok: true }); }
      const account = body.data.account;
      if (account.dead || account.external_id !== row.externalUserId) return c.json(unavailable, 403);
      const user = row.userId ? await options.db.getUserById(row.userId) : null;
      if (user && user.pipedream_external_id !== row.externalUserId) return c.json(unavailable, 403);
      let persisted = false;
      const persist = async () => {
        // Platform admission holds the same owner lock as disconnect through
        // provider verification and the atomic receipt/projection commit.
        const metadata = await options.pipedream.inspectAccount!(account.id);
        if (metadata.id !== account.id || metadata.externalUserId !== row.externalUserId || metadata.app !== 'gmail' || !metadata.healthy || metadata.dead) throw new InvalidReceiptAccount();
        const connected = await store.complete(row, account.id, metadata.email);
        persisted = Boolean(connected);
        if (connected?.inserted) options.emit({ type: "integration:connected", service: "gmail", accountLabel: connected.account_label });
      };
      await options.admit!({ externalUserId: row.externalUserId, accountId: account.id,
        user: user ? { id: user.id, clerkId: user.clerk_id } : null }, persist);
      if (!persisted) await store.fail(row.id);
      return c.json({ ok: true });
    } catch (error) {
      if (error instanceof InvalidReceiptAccount) return c.json(unavailable, 403);
      console.warn("[gmail-attempt] Callback unavailable:", error instanceof Error ? error.name : "UnknownError"); return c.json(unavailable, 503);
    }
  });
  return app;
}
