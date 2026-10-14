import { FUNDED_AI_READINESS_TIMEOUTS, isManagedWorkersAiModel } from "@matrix-os/contracts";
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
import {
  createBedrockFundedUpstream,
} from "./funded-bedrock-upstream.js";
import { isBedrockPricingCurrent, priceBedrockUsageMicrousd } from "./funded-bedrock-route.js";
import { RELAY_SHUTDOWN_TIMEOUT_MS, waitForRelayWork } from "./funded-relay-lifecycle.js";
import { serializeFundedOpenAiRequest } from "./funded-relay-openai-request.js";
import { createFundedUsageTracker } from "./funded-relay-usage.js";
import type { FundedGenerationUpstream } from "./funded-relay-upstream.js";
import type { FundedPlatformClient } from "./funded-relay-platform-client.js";
import { z } from "zod/v4";

const ReadinessQuerySchema = z.object({
  model: z.string().min(1).max(256),
  upstream: z.literal("aws_bedrock").optional(),
}).strict();

export interface FundedRelayService {
  app: Hono;
  close(signal?: AbortSignal): Promise<boolean>;
}

type FundedRelayServiceConfig = FundedRelayConfig & {
  fetch?: typeof fetch;
  now?: () => Date;
  platformClient?: FundedPlatformClient;
  bedrockUpstream?: FundedGenerationUpstream;
};

export function requireFundedRelayServiceConfig(
  env: NodeJS.ProcessEnv = process.env,
): FundedRelayConfig {
  const config = resolveFundedRelayConfig(env);
  if (!config) {
    throw new Error("MATRIX_FUNDED_AI_ENABLED must be true for the dedicated relay service");
  }
  return config;
}

export function createFundedRelayService(config: FundedRelayServiceConfig, options: {
  fetchFn?: typeof fetch;
  now?: () => Date;
  bedrockUpstream?: FundedGenerationUpstream;
} = {}): FundedRelayService {
  const app = new Hono();
  const errorTracker = installPostHogHonoErrorTracking(app, {
    service: "matrix-funded-ai-relay",
  });
  const now = options.now ?? config.now ?? (() => new Date());
  const bedrockUpstream = config.bedrockRoute
    ? options.bedrockUpstream ?? config.bedrockUpstream ?? createBedrockFundedUpstream(config.bedrockRoute)
    : undefined;
  const relay = createFundedRelay({
    ...config,
    ...(options.fetchFn ? { fetch: options.fetchFn } : {}),
    now,
    bedrockUpstream,
  });

  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/ready", async (c) => {
    c.header("Cache-Control", "no-store");
    const bearer = /^Bearer (\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1] ?? "";
    const supplied = Buffer.from(bearer);
    const expected = Buffer.from(config.relayControlToken);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return c.json({ ready: false }, 401);
    }
    const query = ReadinessQuerySchema.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
    if (!query.success) return c.json({ ready: false }, 400);
    const { model } = query.data;
    const bedrockRoute = config.bedrockRoute;
    if (query.data.upstream === "aws_bedrock"
      && bedrockRoute && (model === bedrockRoute.clientModelId || model === bedrockRoute.canonicalModelId)) {
      if (!bedrockUpstream || !isBedrockPricingCurrent(bedrockRoute, now())) {
        return c.json({ ready: false }, 503);
      }
      const priceValidThrough = bedrockRoute.pricing.validThrough;
      try {
        const request = serializeFundedOpenAiRequest({ model: bedrockRoute.clientModelId,
          messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: true },
        new Set([bedrockRoute.clientModelId])).request;
        const result = await bedrockUpstream.dispatch({ request, requestId: `readiness_${now().getTime()}`,
          signal: AbortSignal.timeout(FUNDED_AI_READINESS_TIMEOUTS.relayUpstreamProbeMs) });
        if (!result.response.ok || result.provenance.routeId !== bedrockRoute.routeId
          || result.provenance.pricingVersion !== bedrockRoute.pricing.version
          || !result.response.body) return c.json({ ready: false }, 503);
        const tracker = createFundedUsageTracker({ contentType: result.response.headers.get("content-type") ?? "",
          nativeModelId: bedrockRoute.clientModelId, canonicalModelId: bedrockRoute.canonicalModelId,
          pricingVersion: bedrockRoute.pricing.version, maxCaptureBytes: 64 * 1024,
          priceUsage: (usage) => priceBedrockUsageMicrousd({ route: bedrockRoute,
            pricingVersion: bedrockRoute.pricing.version, usage }) });
        const reader = result.response.body.getReader();
        let bytes = 0;
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 64 * 1024) {
            await reader.cancel("readiness response exceeded limit");
            return c.json({ ready: false }, 503);
          }
          tracker.push(chunk.value);
        }
        if (tracker.complete().mode !== "exact" || !isBedrockPricingCurrent(bedrockRoute, now())) {
          return c.json({ ready: false }, 503);
        }
        return c.json({ ready: true, priceValidThrough });
      } catch (error) {
        console.warn("[proxy] Bedrock readiness probe failed", {
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
        return c.json({ ready: false }, 503);
      }
    }
    if ((!model || !isManagedWorkersAiModel(model)) && model !== FUNDED_SONNET) return c.json({ ready: false }, 400);
    const priceValidThrough = fundedModelPriceValidThrough(model, config.pricingReviews);
    if (!priceValidThrough || !isFundedModelPriceCurrent(model, now(), config.pricingReviews)) {
      return c.json({ ready: false }, 503);
    }
    const probed = await probeFundedModel(config, model, options.fetchFn, {
      probeId: c.req.header("x-matrix-readiness-probe-id"),
      traceId: c.req.header("x-cloud-trace-context")?.split("/")[0],
    });
    const ready = probed && isFundedModelPriceCurrent(model, now(), config.pricingReviews);
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
        const drained = await relay.close(signal);
        if (signal.aborted) return false;
        const tracked = await waitForRelayWork(errorTracker.shutdown(), signal);
        return drained && tracked && !signal.aborted;
      })();
      return closing;
    },
  };
}
