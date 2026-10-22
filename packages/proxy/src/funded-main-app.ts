import { isManagedWorkersAiModel } from "@matrix-os/contracts";
import { installPostHogHonoErrorTracking } from "@matrix-os/observability";
import { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";

import {
  createFundedRelay,
  resolveFundedRelayConfig,
  type FundedRelayConfig,
} from "./funded-relay.js";
import { FUNDED_SONNET, probeFundedModel } from "./funded-relay-readiness.js";
import { fundedModelPriceValidThrough, isFundedModelPriceCurrent } from "./funded-relay-model.js";
import { createManagedRouteControl } from './managed-route-control.js';
import { parseManagedRouteControlConfig, readManagedRouteControlConfig, snapshotFundedRelayConfig,
  type ManagedRouteControlConfig, type FundedRelayServiceConfig } from './managed-route-control-config.js';

export interface FundedRelayService {
  app: Hono;
  close(): Promise<void>;
}

export function requireFundedRelayServiceConfig(
  env: NodeJS.ProcessEnv = process.env,
): FundedRelayServiceConfig {
  const config = resolveFundedRelayConfig(env);
  if (!config) {
    throw new Error("MATRIX_FUNDED_AI_ENABLED must be true for the dedicated relay service");
  }
  const managedRouteControl = readManagedRouteControlConfig(env);
  return managedRouteControl ? { ...config, managedRouteControl } : config;
}

export function createFundedRelayService(input: FundedRelayServiceConfig, options: { fetchFn?: typeof fetch; now?: () => Date; managedRouteControl?: ManagedRouteControlConfig } = {}): FundedRelayService {
  const settings = options.managedRouteControl ?? input.managedRouteControl;
  const config: FundedRelayConfig = settings ? snapshotFundedRelayConfig(input) : input;
  const control = settings ? createManagedRouteControl({ config, settings: parseManagedRouteControlConfig(settings), now: options.now }) : undefined;
  const app = new Hono();
  const errorTracker = installPostHogHonoErrorTracking(app, {
    service: "matrix-funded-ai-relay",
  });
  const relay = createFundedRelay(config);
  control?.register(app);

  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/ready", async (c) => {
    c.header("Cache-Control", "no-store");
    const bearer = /^Bearer (\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1] ?? "";
    const supplied = Buffer.from(bearer);
    const expected = Buffer.from(config.relayControlToken);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return c.json({ ready: false }, 401);
    }
    const model = c.req.query("model");
    if ((!model || !isManagedWorkersAiModel(model)) && model !== FUNDED_SONNET) return c.json({ ready: false }, 400);
    const priceValidThrough = fundedModelPriceValidThrough(model, config.pricingReviews);
    if (!priceValidThrough || !isFundedModelPriceCurrent(model, (options.now ?? (() => new Date()))(), config.pricingReviews)) {
      return c.json({ ready: false }, 503);
    }
    const probed = await probeFundedModel(config, model, options.fetchFn, {
      probeId: c.req.header("x-matrix-readiness-probe-id"),
      traceId: c.req.header("x-cloud-trace-context")?.split("/")[0],
    });
    const ready = probed && isFundedModelPriceCurrent(model, (options.now ?? (() => new Date()))(), config.pricingReviews);
    return c.json(ready ? { ready: true, priceValidThrough } : { ready: false }, ready ? 200 : 503);
  });
  relay.register(app);

  return {
    app,
    async close() {
      await control?.close();
      await relay.close();
      await errorTracker.shutdown();
    },
  };
}
