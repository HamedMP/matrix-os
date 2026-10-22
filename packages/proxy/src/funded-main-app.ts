import { isFundedCloudflarePreviewCohortModel, isFundedThirdPartyPreviewModel, isManagedFundedOpenAiModel } from "@matrix-os/contracts";
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
import { RELAY_SHUTDOWN_TIMEOUT_MS, waitForRelayWork } from "./funded-relay-lifecycle.js";
import { createManagedRouteControl } from './managed-route-control.js';
import { parseManagedRouteControlConfig, readManagedRouteControlConfig, snapshotFundedRelayConfig,
  type ManagedRouteControlConfig, type FundedRelayServiceConfig } from './managed-route-control-config.js';

export interface FundedRelayService {
  app: Hono;
  close(signal?: AbortSignal): Promise<boolean>;
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
  const now = options.now ?? (() => new Date());
  const relay = createFundedRelay({
    ...config,
    ...(options.fetchFn ? { fetch: options.fetchFn } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
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
    if ((!model || !isManagedFundedOpenAiModel(model)) && model !== FUNDED_SONNET) return c.json({ ready: false }, 400);
    if (isFundedThirdPartyPreviewModel(model)
      || config.cloudflarePreview && !isFundedCloudflarePreviewCohortModel(model)) return c.json({ ready: false }, 400);
    const initial = await relay.pricingReviewsFor(model, c.req.raw.signal);
    if (!initial || !isFundedModelPriceCurrent(model, now(), initial)) {
      return c.json({ ready: false }, 503);
    }
    const probed = await probeFundedModel(config, model, options.fetchFn, {
      probeId: c.req.header("x-matrix-readiness-probe-id"),
      traceId: c.req.header("x-cloud-trace-context")?.split("/")[0],
    });
    const current = probed ? await relay.pricingReviewsFor(model, c.req.raw.signal) : null;
    const priceValidThrough = current && isFundedModelPriceCurrent(model, now(), current)
      ? fundedModelPriceValidThrough(model, current) : undefined;
    return priceValidThrough
      ? c.json({ ready: true, priceValidThrough }, 200) : c.json({ ready: false }, 503);
  });
  relay.register(app);
  let closing: Promise<boolean> | undefined;

  return {
    app,
    close(shutdownSignal?: AbortSignal) {
      if (closing) return closing;
      const signal = shutdownSignal ?? AbortSignal.timeout(RELAY_SHUTDOWN_TIMEOUT_MS);
      closing = (async () => {
        const [drained, controlDrained] = await Promise.all([relay.close(signal),
          waitForRelayWork(control?.close() ?? Promise.resolve(), signal)]);
        if (signal.aborted) return false;
        const tracked = await waitForRelayWork(errorTracker.shutdown(), signal);
        return drained && controlDrained && tracked && !signal.aborted;
      })();
      return closing;
    },
  };
}
