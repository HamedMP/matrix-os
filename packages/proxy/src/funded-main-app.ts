import { installPostHogHonoErrorTracking } from "@matrix-os/observability";
import { Hono } from "hono";

import {
  createFundedRelay,
  resolveFundedRelayConfig,
  type FundedRelayConfig,
} from "./funded-relay.js";

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

export function createFundedRelayService(config: FundedRelayConfig): FundedRelayService {
  const app = new Hono();
  const errorTracker = installPostHogHonoErrorTracking(app, {
    service: "matrix-funded-ai-relay",
  });
  const relay = createFundedRelay(config);

  app.get("/health", (c) => c.json({ status: "ok" }));
  relay.register(app);

  return {
    app,
    async close() {
      await relay.close();
      await errorTracker.shutdown();
    },
  };
}
