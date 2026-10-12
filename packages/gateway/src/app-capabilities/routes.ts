import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { AppCapabilityRequestSchema, MAX_APP_CAPABILITY_BYTES } from "@matrix-os/contracts";
import { BotIntegrationError, type BotIntegrationClient } from "../bots/integration-client.js";
import { validateActionParams } from "../integrations/parameter-validation.js";
import { readAppCapabilityGrant } from "./policy.js";

interface Options {
  homePath: string;
  ownerIds: readonly string[];
  resolveOwner: (context: Context) => string | null;
  integrations: Pick<BotIntegrationClient, "inventory" | "describe" | "callAppAction"> | null;
  aiAllowed: (app: string) => Promise<boolean>;
}

const failures = {
  missing: { error: "Integration account unavailable" },
  ambiguous: { error: "Choose an integration account" },
  denied: { error: "App integration access denied" },
  invalid: { error: "Invalid integration request" },
  unavailable: { error: "App integrations are unavailable" },
} as const;

/** All shells use this owner-authorized app contract, including production VPSes. */
export function createAppCapabilityRoutes(options: Options): Hono {
  const routes = new Hono();
  let inFlight = 0;
  let windowStart = 0;
  let requests = 0;
  routes.post("/", bodyLimit({ maxSize: MAX_APP_CAPABILITY_BYTES }), async context => {
    const owner = options.resolveOwner(context);
    if (!owner || !options.ownerIds.includes(owner)) return context.json(failures.denied, 403);
    let body: unknown;
    try { body = await context.req.json(); }
    catch (error: unknown) {
      if (error instanceof Error && error.name === "BodyLimitError") return context.json({ error: "Request too large" }, 413);
      if (!(error instanceof SyntaxError)) console.warn("[app-capabilities] invalid body", error instanceof Error ? error.name : "UnknownError");
      return context.json(failures.invalid, 400);
    }
    const parsed = AppCapabilityRequestSchema.safeParse(body);
    if (!parsed.success) return context.json(failures.invalid, 400);
    const { app, input } = parsed.data;
    const now = Date.now();
    if (now - windowStart >= 60_000) { windowStart = now; requests = 0; }
    if (requests >= 120 || inFlight >= 8) return context.json({ error: "App integrations are busy" }, 429);
    requests++; inFlight++;
    try {
      const grant = await readAppCapabilityGrant(options.homePath, app);
      if (input.kind === "capabilities") return context.json({
        version: 1,
        integrations: Boolean(options.integrations && grant && Object.keys(grant.services).length),
        ai: await options.aiAllowed(app),
      });
      if (!grant || (input.kind !== "integrations.list" && !grant.services[input.service])) return context.json(failures.denied, 403);
      if (!options.integrations) return context.json(failures.unavailable, 503);
      if (input.kind === "integrations.call" && !grant.services[input.service]?.includes(input.action)) return context.json(failures.denied, 403);
      const signal = AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(30_000)]);
      {
        signal.throwIfAborted();
        const client = options.integrations;
        if (input.kind === "integrations.list") {
          const connections = await client.inventory(owner, signal);
          return context.json({ services: connections.filter(row => Object.hasOwn(grant.services, row.service)).map(row => ({
            service: row.service, account_label: row.label, status: "active",
          })) });
        }
        const actions = await client.describe(owner, { service: input.service, readOnly: false }, signal);
        const allowed = actions.filter(action => grant.services[input.service]?.includes(action.id));
        if (input.kind === "integrations.describe") return context.json({
          service: input.service, name: input.service, actions: allowed.map(({ id, description, risk, params }) => ({ id, description, risk, params })),
        });
        const action = allowed.find(action => action.id === input.action);
        if (!action) return context.json(failures.unavailable, 503);
        const params = input.params ?? {};
        // Runtime catalog is authoritative; never ignore caller filters or guess aliases.
        if (Object.keys(params).some(key => !Object.hasOwn(action.params, key))
          || !validateActionParams(action, params).valid) return context.json(failures.invalid, 400);
        const accounts = (await client.inventory(owner, signal)).filter(row => row.service === input.service
          && (input.label === undefined || row.label === input.label));
        if (accounts.length === 0) return context.json(failures.missing, 404);
        if (accounts.length !== 1) return context.json(failures.ambiguous, 409);
        // Authorization may change during discovery or an account lookup.
        const current = await readAppCapabilityGrant(options.homePath, app);
        if (!current?.services[input.service]?.includes(input.action)) return context.json(failures.denied, 403);
        signal.throwIfAborted();
        const result = await client.callAppAction(owner, {
          service: input.service, action: input.action, label: accounts[0].label,
          connectionId: accounts[0].connectionId, params, read: action.risk === "read",
        }, signal);
        return context.json({ ...result, service: input.service, action: input.action });
      }
    } catch (error: unknown) {
      console.warn("[app-capabilities] request failed", error instanceof Error ? error.name : "UnknownError");
      if (error instanceof BotIntegrationError) {
        if (error.effectUnknown) return context.json({ error: "Integration result is uncertain. Check the service before retrying." }, 502);
        const status = error.code === "ambiguous" ? 409 : error.code === "missing" ? 404
          : error.code === "denied" ? 403 : error.code === "invalid" ? 400 : 503;
        return context.json(failures[error.code], status);
      }
      return context.json(failures.unavailable, 503);
    } finally { inFlight--; }
  });
  return routes;
}
