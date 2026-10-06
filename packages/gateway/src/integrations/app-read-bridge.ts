import { open } from "node:fs/promises";
import { join } from "node:path";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { AppIntegrationAppSchema, AppIntegrationCallSchema, type AppIntegrationInput } from "@matrix-os/contracts";
import { createBotIntegrationClient, BotIntegrationError, type BotIntegrationClient, type BotIntegrationTransport } from "../bots/integration-client.js";
import { requireRequestPrincipal, isRequestPrincipalError, mapRequestPrincipalError } from "../request-principal.js";
import { validateActionParams } from "./parameter-validation.js";
import { getAction, getService } from "./registry.js";

const GrantSchema = z.strictObject({
  app: AppIntegrationAppSchema,
  service: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  actions: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)).min(1).max(64),
  connectionIds: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/)).min(1).max(64),
  // Fixed source selectors (repo/team/channel/project), never URLs or credentials.
  params: z.record(z.string().max(128), z.union([z.string().max(512), z.number().finite(), z.boolean()])),
});
const PolicySchema = z.strictObject({ grants: z.array(GrantSchema).max(128) });
const ManifestSchema = z.object({ slug: AppIntegrationAppSchema, permissions: z.array(z.string().max(128)).max(128) });
const QuerySchema = z.strictObject({ app: AppIntegrationAppSchema });

async function readBoundedFile(path: string, limit: number): Promise<unknown | null> {
  try {
    const file = await open(path, "r");
    try {
      const bytes = Buffer.alloc(limit + 1);
      let bytesRead = 0;
      while (bytesRead < bytes.length) {
        const part = await file.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
        if (!part.bytesRead) break;
        bytesRead += part.bytesRead;
      }
      if (bytesRead > limit) throw new Error("App integration policy is too large");
      return JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export class AppIntegrationReadError extends Error {
  constructor(readonly code: "denied" | "invalid" | "unavailable" | "busy") {
    super("App integration read is unavailable"); this.name = "AppIntegrationReadError";
  }
}

interface ReadServiceOptions {
  homePath: string;
  ownerIds: readonly string[];
  client: Pick<BotIntegrationClient, "call" | "inventory"> | null;
}

/** The caller derives ownerId from authenticated admission or a persisted owner-authorized job. */
export function createAppIntegrationReadService(options: ReadServiceOptions) {
  let inFlight = 0;
  let requests = 0;
  let windowStart = 0;
  async function grantsFor(ownerId: string, app: string) {
    if (!options.ownerIds.includes(ownerId)) throw new AppIntegrationReadError("denied");
    AppIntegrationAppSchema.parse(app);
    const [policy, manifest] = await Promise.all([
      readBoundedFile(join(options.homePath, "system/app-integrations.json"), 65_536),
      readBoundedFile(join(options.homePath, "apps", app, "matrix.json"), 65_536),
    ]);
    if (!policy || !manifest) throw new AppIntegrationReadError("denied");
    const grants = PolicySchema.parse(policy).grants;
    const declaration = ManifestSchema.parse(manifest);
    if (declaration.slug !== app) throw new AppIntegrationReadError("denied");
    return grants.filter((grant) => grant.app === app
      && declaration.permissions.includes(`integrations:${grant.service}:read`));
  }
  function begin(countRead = true) {
    const now = Date.now();
    if (now - windowStart >= 60_000) { windowStart = now; requests = 0; }
    if ((countRead && requests >= 120) || inFlight >= 4) throw new AppIntegrationReadError("busy");
    if (countRead) requests++;
    inFlight++;
    return () => { inFlight--; };
  }
  async function validate(request: AppIntegrationInput & { ownerId: string; app: string }, signal: AbortSignal) {
    const { ownerId, ...body } = request;
    const parsed = AppIntegrationCallSchema.safeParse(body);
    if (!parsed.success) throw new AppIntegrationReadError("invalid");
    const { app, ...input } = parsed.data;
    const permitted = (grants: z.infer<typeof GrantSchema>[]) => grants.some((grant) =>
      grant.service === input.service && grant.actions.includes(input.action) && grant.connectionIds.includes(input.connectionId)
      && Object.entries(grant.params).every(([key, value]) => input.params[key] === value));

    const grants = await grantsFor(ownerId, app);
    const action = getAction(input.service, input.action);
    if (!permitted(grants) || action?.risk !== "read" || getService(input.service)?.connectorKind !== "pipedream") throw new AppIntegrationReadError("denied");
    if (!validateActionParams(action, input.params).valid) throw new AppIntegrationReadError("invalid");
    if (!options.client) throw new AppIntegrationReadError("unavailable");
    signal.throwIfAborted();
    const connections = await options.client.inventory(ownerId, signal);
    if (!connections.some((connection) => connection.connectionId === input.connectionId && connection.service === input.service && connection.label === input.label)) throw new AppIntegrationReadError("denied");
    if (!permitted(await grantsFor(ownerId, app))) throw new AppIntegrationReadError("denied");
    signal.throwIfAborted();
    return { ownerId, input };
  }
  const service = {
    async inventory(input: { ownerId: string; app: string }, signal: AbortSignal) {
      const end = begin();
      try {
        const grants = await grantsFor(input.ownerId, input.app);
        if (!grants.length) throw new AppIntegrationReadError("denied");
        if (!options.client) throw new AppIntegrationReadError("unavailable");
        const bounded = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
        bounded.throwIfAborted();
        const connections = await options.client.inventory(input.ownerId, bounded);
        const current = await grantsFor(input.ownerId, input.app);
        if (!current.length) throw new AppIntegrationReadError("denied");
        return { connections: connections.flatMap((connection) => {
          const matching = current.filter((grant) => grant.service === connection.service && grant.connectionIds.includes(connection.connectionId));
          const actions = [...new Set(matching.flatMap((grant) => grant.actions))].filter((action) => getAction(connection.service, action)?.risk === "read");
          return actions.length ? [{ ...connection, actions }] : [];
        }) };
      } finally { end(); }
    },
    async authorize(request: AppIntegrationInput & { ownerId: string; app: string }, signal: AbortSignal): Promise<void> {
      // Internal bounded job/config grant fences do not dispatch provider actions.
      const end = begin(false);
      try { await validate(request, AbortSignal.any([signal, AbortSignal.timeout(25_000)])); }
      finally { end(); }
    },
    async read(request: AppIntegrationInput & { ownerId: string; app: string }, signal: AbortSignal) {
      const end = begin();
      try {
        const bounded = AbortSignal.any([signal, AbortSignal.timeout(25_000)]);
        const { ownerId, input } = await validate(request, bounded);
        return await options.client!.call(ownerId, { ...input, read: true }, bounded);
      } finally { end(); }
    },
  };
  return service;
}
export type AppIntegrationReadService = ReturnType<typeof createAppIntegrationReadService>;

export function createAppIntegrationReadRoutes(options: ReadServiceOptions & {
  service?: AppIntegrationReadService;
  getPrincipal?: (context: Context) => { userId: string };
}): Hono {
  const routes = new Hono();
  const service = options.service ?? createAppIntegrationReadService(options);
  const owner = (c: Context) => (options.getPrincipal ?? requireRequestPrincipal)(c).userId;
  function failure(c: Context, error: unknown) {
    if (isRequestPrincipalError(error)) {
      const mapped = mapRequestPrincipalError(error);
      return c.json(mapped.body, mapped.status);
    }
    console.warn("[app-integrations] read failed:", error instanceof Error ? error.name : "UnknownError");
    const code = error instanceof AppIntegrationReadError || error instanceof BotIntegrationError ? error.code : "unavailable";
    const status = code === "denied" ? 403 : code === "invalid" ? 400 : code === "busy" ? 429 : 503;
    return c.json({ error: code === "denied" ? "App integration access denied" : "App integration read is unavailable" }, status);
  }
  routes.get("/", async (c) => {
    const params = new URL(c.req.url).searchParams;
    const parsed = QuerySchema.safeParse(Object.fromEntries(params));
    if (!parsed.success || [...params].length !== Object.keys(parsed.data).length) return c.json({ error: "Invalid app integration request" }, 400);
    try {
      return c.json(await service.inventory({ ownerId: owner(c), app: parsed.data.app }, c.req.raw.signal));
    } catch (error) { return failure(c, error); }
  });
  routes.post("/", bodyLimit({ maxSize: 65_536 }), async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch (error) {
      if (error instanceof Error && error.name === "BodyLimitError") return c.json({ error: "Request too large" }, 413);
      if (!(error instanceof SyntaxError)) console.warn("[app-integrations] invalid body:", error instanceof Error ? error.name : "UnknownError");
      return c.json({ error: "Invalid app integration request" }, 400);
    }
    const parsed = AppIntegrationCallSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "Invalid app integration request" }, 400);
    try {
      return c.json(await service.read({ ownerId: owner(c), ...parsed.data }, c.req.raw.signal));
    } catch (error) { return failure(c, error); }
  });
  return routes;
}

/** Fixed server-owned transport; no app-supplied URL, identity header or token. */
export function createRuntimeAppIntegrationReadService(options: {
  homePath: string; ownerIds: readonly string[]; transport: BotIntegrationTransport | null;
}) {
  return createAppIntegrationReadService({ ...options, client: options.transport ? createBotIntegrationClient(options.transport) : null });
}
export function createRuntimeAppIntegrationReadRoutes(options: {
  homePath: string; ownerIds: readonly string[]; transport: BotIntegrationTransport | null;
}) {
  return createAppIntegrationReadRoutes({ ...options, client: null, service: createRuntimeAppIntegrationReadService(options) });
}
