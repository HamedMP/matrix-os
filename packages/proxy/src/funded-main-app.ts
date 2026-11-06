import { isManagedWorkersAiModel } from "@matrix-os/contracts";
import { installPostHogHonoErrorTracking } from "@matrix-os/observability";
import { bodyLimit } from "hono/body-limit";
import { OperatorProbeRequestSchema } from "@matrix-os/contracts/funded-operator-probe";
import { createOperatorProbeExecutor } from "./operator-probe-execution.js";
import { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";

import {
  createFundedRelay,
  resolveFundedRelayConfig,
  type FundedRelayConfig,
} from "./funded-relay.js";
import { FUNDED_SONNET, probeFundedModel } from "./funded-relay-readiness.js";
import { fundedModelPriceValidThrough, isFundedModelPriceCurrent } from "./funded-relay-model.js";
import { RELAY_SHUTDOWN_TIMEOUT_MS, waitForRelayWork } from "./funded-relay-lifecycle.js";

export interface FundedRelayService {
  app: Hono;
  close(signal?: AbortSignal): Promise<boolean>;
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

export function createFundedRelayService(config: FundedRelayConfig, options: { fetchFn?: typeof fetch; now?: () => Date } = {}): FundedRelayService {
  const app = new Hono();
  const errorTracker = installPostHogHonoErrorTracking(app, {
    service: "matrix-funded-ai-relay",
  });
  const relay = createFundedRelay(config);

  app.get("/health", (c) => c.json({ status: "ok" }));
  app.use("/ready", async (c, next) => {
    c.header("Cache-Control", "no-store");
    const bearer = /^Bearer (\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1] ?? "";
    const supplied = Buffer.from(bearer);
    const expected = Buffer.from(config.relayControlToken);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return c.json({ ready: false }, 401);
    }
    await next();
  });
  const operatorProbes = config.operatorProbeBudgetRequired
    ? createOperatorProbeExecutor(config, options.fetchFn ?? fetch, options.now ?? (() => new Date())) : undefined;
  if (operatorProbes) {
    app.post("/ready", bodyLimit({ maxSize: 1024 }), async c => {
      if (new URL(c.req.url).search) return c.json({ ready: false }, 400);
      let raw: unknown;
      try { raw = await c.req.json(); } catch (error: unknown) {
        if (!(error instanceof SyntaxError)) throw error;
        return c.json({ ready: false }, 400);
      }
      const parsed = OperatorProbeRequestSchema.safeParse(raw);
      if (!parsed.success) return c.json({ ready: false }, 400);
      try {
        await operatorProbes.run(parsed.data, c.req.raw.signal);
        return c.body(null, 204); // Platform reads the committed authority attempt.
      } catch (error: unknown) {
        console.warn("[operator-probe] Execution unavailable", { invalidInput: error instanceof SyntaxError });
        return c.json({ ready: false }, 503);
      }
    });
  }
  app.get("/ready", async (c) => {
    if (operatorProbes) return c.json({ ready: false }, 405);
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
  let closing: Promise<boolean> | undefined;

  return {
    app,
    close(shutdownSignal?: AbortSignal) {
      if (closing) return closing;
      const signal = shutdownSignal ?? AbortSignal.timeout(RELAY_SHUTDOWN_TIMEOUT_MS);
      closing = (async () => {
        const [drained, probesDrained] = await Promise.all([relay.close(signal), operatorProbes?.close(signal) ?? true]);
        if (signal.aborted) return false;
        const tracked = await waitForRelayWork(errorTracker.shutdown(), signal);
        return drained && probesDrained && tracked && !signal.aborted;
      })();
      return closing;
    },
  };
}
