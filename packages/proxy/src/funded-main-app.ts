import { installPostHogHonoErrorTracking } from "@matrix-os/observability";
import { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";

import {
  createFundedRelay,
  resolveFundedRelayConfig,
  type FundedRelayConfig,
} from "./funded-relay.js";
import { FUNDED_SONNET, probeFundedModel } from "./funded-relay-readiness.js";
import { FUNDED_GLM_FLASH } from "./funded-relay-model.js";

export interface FundedRelayService {
  app: Hono;
  close(): Promise<void>;
}

export function requireFundedRelayServiceConfig(
  env: NodeJS.ProcessEnv = process.env,
): FundedRelayConfig {
  const config = resolveFundedRelayConfig(env);
  if (!config) {
    throw new Error("MATRIX_FUNDED_AI_ENABLED must be true for the dedicated relay service");
  }
  return config;
}

export function createFundedRelayService(config: FundedRelayConfig, options: { fetchFn?: typeof fetch } = {}): FundedRelayService {
  const app = new Hono();
  const errorTracker = installPostHogHonoErrorTracking(app, {
    service: "matrix-funded-ai-relay",
  });
  const relay = createFundedRelay(config);

  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/ready", async (c) => {
    const bearer = /^Bearer (\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1] ?? "";
    const supplied = Buffer.from(bearer);
    const expected = Buffer.from(config.relayControlToken);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return c.json({ ready: false }, 401);
    }
    const model = c.req.query("model");
    if (model !== FUNDED_GLM_FLASH && model !== FUNDED_SONNET) return c.json({ ready: false }, 400);
    const ready = await probeFundedModel(config, model, options.fetchFn);
    c.header("Cache-Control", "no-store");
    return c.json({ ready }, ready ? 200 : 503);
  });
  relay.register(app);

  return {
    app,
    async close() {
      await relay.close();
      await errorTracker.shutdown();
    },
  };
}
