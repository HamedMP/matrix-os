import { describe, expect, it, vi } from "vitest";
import { createFundedRelayService } from "../../packages/proxy/src/funded-main-app.js";
import { resolveFundedRelayConfig } from "../../packages/proxy/src/funded-relay-config.js";

const relayToken = "relay-token-".repeat(3);
const platformUrl = "https://platform.example.test";
const snapshotUrl = platformUrl + "/internal/ai/funded/pricing-reviews";
const modelId = "anthropic/claude-sonnet-5";
const checkedAt = Date.parse("2026-11-11T10:00:00.000Z");
const review = {
  modelId,
  version: "anthropic-2026-08-31-standard",
  reviewedAt: "2026-11-10T00:00:00.000Z",
  validThrough: "2026-11-18T00:00:00.000Z",
  sourceDigest: "a".repeat(64),
  blockedAt: null as string | null,
};

function config(registry = "true") {
  return resolveFundedRelayConfig({
    MATRIX_FUNDED_AI_ENABLED: "true",
    MATRIX_FUNDED_AI_PRICING_REGISTRY_ENABLED: registry,
    MATRIX_FUNDED_SONNET_PRICING_REVIEW_VERSION: review.version,
    MATRIX_FUNDED_SONNET_PRICING_REVIEWED_AT: review.reviewedAt,
    MATRIX_FUNDED_SONNET_PRICING_VALID_THROUGH: review.validThrough,
    CLOUDFLARE_AI_GATEWAY_URL: "https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/preview/anthropic",
    CLOUDFLARE_AI_GATEWAY_TOKEN: "g".repeat(32),
    PLATFORM_INTERNAL_URL: platformUrl,
    AI_RELAY_CONTROL_TOKEN: relayToken,
    AI_RELAY_METADATA_SECRET: "m".repeat(32),
  })!;
}

function snapshot(reviews: (typeof review)[] = [review]) {
  return Response.json({ contractVersion: 1, reviews });
}

function upstream() {
  return Response.json({ type: "message", model: "claude-sonnet-5", content: [] });
}

async function ready(service: ReturnType<typeof createFundedRelayService>) {
  return service.app.request("/ready?model=" + encodeURIComponent(modelId), {
    headers: { authorization: "Bearer " + relayToken },
  });
}

describe("Funded AI Relay pricing registry", () => {
  it("reuses authenticated current reviews across callers and stops on a refresh failure", async () => {
    let timestamp = checkedAt;
    let loads = 0;
    let probes = 0;
    const renewed = { ...review, validThrough: "2026-12-10T00:00:00.000Z" };
    const fetchFn = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url) === snapshotUrl) {
        expect(init?.method).toBe("GET");
        expect(init?.redirect).toBe("error");
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer " + relayToken);
        loads += 1;
        if (loads === 1) return snapshot();
        if (loads === 2) return new Response(null, { status: 503 });
        return snapshot([renewed]);
      }
      probes += 1;
      return upstream();
    });
    const service = createFundedRelayService(config(), { fetchFn, now: () => new Date(timestamp) });
    try {
      const first = await Promise.all([ready(service), ready(service)]);
      expect(first.map((response) => response.status)).toEqual([200, 200]);
      expect(await first[0]!.json()).toEqual({ ready: true, priceValidThrough: review.validThrough });
      expect(loads).toBe(1);
      timestamp += 30_001;
      expect((await ready(service)).status).toBe(503);
      expect(probes).toBe(2);
      expect(loads).toBe(2);
      const recovered = await ready(service);
      expect(recovered.status).toBe(200);
      expect(await recovered.json()).toEqual({ ready: true, priceValidThrough: renewed.validThrough });
      expect(probes).toBe(3);
      expect(loads).toBe(3);
    } finally {
      await service.close();
    }
  });

  it.each([
    { name: "missing", entries: [] },
    { name: "expired", entries: [{ ...review, validThrough: "2026-11-11T00:00:00.000Z" }] },
    { name: "blocked", entries: [{ ...review, blockedAt: new Date(checkedAt).toISOString() }] },
    { name: "wrong version", entries: [{ ...review, version: "unreviewed-version" }] },
    { name: "duplicate", entries: [review, review] },
  ])("skips the upstream for $name reviews even with a valid environment review", async ({ entries }) => {
    const fetchFn = vi.fn<typeof fetch>(async (url) => String(url) === snapshotUrl ? snapshot(entries) : upstream());
    const service = createFundedRelayService(config(), { fetchFn, now: () => new Date(checkedAt) });
    try {
      expect((await ready(service)).status).toBe(503);
      expect(fetchFn.mock.calls.map(([url]) => String(url))).toEqual([snapshotUrl]);
    } finally {
      await service.close();
    }
  });

  it("clips readiness to a future pricing block", async () => {
    const blockedAt = new Date(checkedAt + 1_000).toISOString();
    const fetchFn = vi.fn<typeof fetch>(async (url) => String(url) === snapshotUrl
      ? snapshot([{ ...review, blockedAt }]) : upstream());
    const service = createFundedRelayService(config(), { fetchFn, now: () => new Date(checkedAt) });
    try {
      expect(await (await ready(service)).json()).toEqual({ ready: true, priceValidThrough: blockedAt });
    } finally {
      await service.close();
    }
  });

  it("authenticates before reading the registry and rejects an oversized snapshot", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => Response.json({
      contractVersion: 1,
      reviews: [review],
      extra: "x".repeat(1024),
    }));
    const service = createFundedRelayService({ ...config(), maxControlResponseBytes: 1024 }, {
      fetchFn, now: () => new Date(checkedAt),
    });
    try {
      const unauthenticated = await service.app.request("/ready?model=" + encodeURIComponent(modelId));
      expect(unauthenticated.status).toBe(401);
      expect(fetchFn).not.toHaveBeenCalled();
      expect((await ready(service)).status).toBe(503);
      expect(fetchFn.mock.calls.map(([url]) => String(url))).toEqual([snapshotUrl]);
    } finally {
      await service.close();
    }
  });

  it("keeps environment reviews and avoids the registry with activation disabled", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => upstream());
    const service = createFundedRelayService(config("false"), { fetchFn, now: () => new Date(checkedAt) });
    try {
      expect((await ready(service)).status).toBe(200);
      expect(fetchFn).toHaveBeenCalledOnce();
      expect(fetchFn.mock.calls[0]?.[0]).not.toBe(snapshotUrl);
      expect(() => config("enabled")).toThrow(/MATRIX_FUNDED_AI_PRICING_REGISTRY_ENABLED/);
    } finally {
      await service.close();
    }
  });
});
