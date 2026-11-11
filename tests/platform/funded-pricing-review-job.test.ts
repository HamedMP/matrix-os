import { describe, expect, it, vi } from "vitest";
import { FUNDED_PRICING_CATALOG, type FundedAiPricingReview } from "@matrix-os/contracts";
import {
  runFundedPricingReview,
  runFundedPricingWatchdog,
  startFundedPricingReviewJob,
  type FundedPricingReviewJobStore,
} from "../../packages/platform/src/funded-pricing-review-job.js";
import {
  FUNDED_PRICING_SOURCE_URLS,
  readOfficialFundedPricing,
  type OfficialPricingObservation,
} from "../../packages/platform/src/funded-pricing-review-job-sources.js";

const glm = "@cf/zai-org/glm-5.3";
const qwen = "@cf/qwen/qwen3.8-27b";
const gemma = "@cf/google/gemma-4-26b-a4b-it";
const sonnet = "anthropic/claude-sonnet-5";
const now = new Date("2026-11-11T00:00:00.000Z");
const digest = "e".repeat(64);

const pricing = [
  "| Model | Price in Tokens | Price in Neurons |",
  "| --- | --- | --- |",
  "| @cf/zai-org/glm-5.3 | $1.400 per M input tokens <br> $0.260 per M cached input tokens <br> $4.400 per M output tokens | 127273 neurons per M input tokens |",
  "| @cf/qwen/qwen3.8-27b | $0.450 per M input tokens <br> $3.200 per M output tokens | 40909 neurons per M input tokens |",
  "| @cf/google/gemma-4-26b-a4b-it | $0.100 per M input tokens <br> $0.300 per M output tokens | 9091 neurons per M input tokens |",
].join("\n");
const changelog = [
  "# Workers AI Changelog",
  "[<h2>Planned model deprecations on Workers AI</h2>](https://developers.cloudflare.com/changelog/post/2026-11-05-planned-model-deprecations/)",
  "#### Models deprecated on November 20, 2026",
  "#### LLMs",
  "* `@cf/zai-org/glm-5.3`",
  "#### Other models",
].join("\n");

function sourceFetch(
  workersPricing = pricing,
  notice = changelog,
  sonnetStatus = "Active | N/A | Not sooner than June 30, 2027",
) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === FUNDED_PRICING_SOURCE_URLS.workers) return new Response(workersPricing);
    if (url === FUNDED_PRICING_SOURCE_URLS.changelog) return new Response(notice);
    if (url.endsWith("/qwen3.8-27b/index.md")) {
      return new Response("Model ID\n\n`@cf/qwen/qwen3.8-27b` Copy\n\n| Unit Pricing | $0.45 per M input tokens, $3.20 per M output tokens, $0.05 per M cached input tokens |");
    }
    if (url.endsWith("/gemma-4-26b-a4b-it/index.md")) {
      return new Response("Model ID\n\n`@cf/google/gemma-4-26b-a4b-it` Copy\n\n| Unit Pricing | $0.10 per M input tokens, $0.30 per M output tokens |");
    }
    if (url === FUNDED_PRICING_SOURCE_URLS.sonnet) {
      return new Response("Model ID\n\n`anthropic/claude-sonnet-5` Copy\n\n| Pricing | <ul><li>Input (per 1M tokens)$2.00</li><li>Output (per 1M tokens)$10.00</li><li>Cached input (per 1M tokens)$0.20</li><li>Cache creation (per 1M tokens)$2.50</li></ul> |");
    }
    if (url === FUNDED_PRICING_SOURCE_URLS.anthropicLifecycle) {
      return new Response(`## Model status\n\n| API model name | Current state | Deprecated | Tentative retirement date |\n| --- | --- | --- | --- |\n| claude-sonnet-5 | ${sonnetStatus} |`);
    }
    if (url === FUNDED_PRICING_SOURCE_URLS.anthropic) {
      return new Response([
        "| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |",
        "| --- | --- | --- | --- | --- | --- |",
        "| Claude Sonnet 5 | $2 / MTok<sup>3</sup> | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok<sup>3</sup> |",
        "### Batch processing",
        "| Claude Sonnet 5 | $1 / MTok | $5 / MTok |",
      ].join("\n"));
    }
    return new Response(null, { status: 404 });
  });
}

describe("official funded pricing verification", () => {
  const catalog = {
    [glm]: FUNDED_PRICING_CATALOG[glm],
    [qwen]: FUNDED_PRICING_CATALOG[qwen],
    [gemma]: FUNDED_PRICING_CATALOG[gemma],
    [sonnet]: FUNDED_PRICING_CATALOG[sonnet],
  };

  it("requires model-specific cache evidence and reads the provider retirement deadline", async () => {
    const fetchFn = sourceFetch();
    const result = await readOfficialFundedPricing({ fetchFn, signal: new AbortController().signal, catalog });
    expect(result).toMatchObject({
      [glm]: { kind: "match", retiredAt: "2026-11-20T00:00:00.000Z" },
      [qwen]: { kind: "match", retiredAt: null },
      [gemma]: { kind: "inconclusive", retiredAt: null },
      [sonnet]: { kind: "match", retiredAt: null },
    });
    expect(result[glm]?.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
    for (const call of fetchFn.mock.calls) {
      expect(String(call[0])).toMatch(/^https:\/\/(developers.cloudflare.com|platform.claude.com)\//);
    }
  });

  it("blocks confirmed rate changes but refuses duplicate or malformed evidence", async () => {
    const signal = new AbortController().signal;
    const original = { [glm]: catalog[glm] };
    const changed = sourceFetch(pricing.replace("$4.400", "$5.100"));
    expect((await readOfficialFundedPricing({ fetchFn: changed, signal, catalog: original }))[glm]?.kind).toBe("changed");
    const duplicate = sourceFetch(pricing + "\n" + pricing.split("\n")[2]);
    expect((await readOfficialFundedPricing({ fetchFn: duplicate, signal, catalog: original }))[glm]?.kind).toBe("inconclusive");
    const changedNotice = sourceFetch(pricing, changelog.replace("November 20, 2026", "next Friday"));
    expect((await readOfficialFundedPricing({ fetchFn: changedNotice, signal, catalog: original }))[glm]?.kind).toBe("inconclusive");
  });

  it("detects the exact Sonnet model retirement and ignores variants that remain active", async () => {
    const notice = changelog + "\n#### Variants that remain active\n- `@cf/qwen/qwen3.8-27b`";
    const fetchFn = sourceFetch(pricing, notice, "Deprecated | November 8, 2026 | November 30, 2026");
    const result = await readOfficialFundedPricing({ fetchFn, signal: new AbortController().signal, catalog });
    expect(result[sonnet]?.retiredAt).toBe("2026-11-30T00:00:00.000Z");
    expect(result[qwen]?.retiredAt).toBeNull();
  });

  it("refuses renewal when the official retirement source is unavailable", async () => {
    const fetchFn = vi.fn(async (input: string | URL | Request) =>
      String(input) === FUNDED_PRICING_SOURCE_URLS.changelog
        ? new Response(null, { status: 503 }) : sourceFetch()(input));
    const result = await readOfficialFundedPricing({ fetchFn, signal: new AbortController().signal, catalog: { [glm]: catalog[glm] } });
    expect(result[glm]?.kind).toBe("inconclusive");
  });
});

function existing(modelId: string, days: number): FundedAiPricingReview {
  const version = Object.entries(FUNDED_PRICING_CATALOG).find(([id]) => id === modelId)![1].version;
  return {
    modelId: modelId as FundedAiPricingReview["modelId"], version,
    reviewedAt: "2026-10-20T00:00:00.000Z",
    validThrough: new Date(now.getTime() + days * 86_400_000).toISOString(),
    blockedAt: null, sourceDigest: digest,
  };
}

function jobStore(records: FundedAiPricingReview[]): FundedPricingReviewJobStore {
  return {
    list: vi.fn(async () => records),
    save: vi.fn(async () => true),
    claim: vi.fn(async () => "lease-1"),
    finish: vi.fn(async () => undefined),
    watchdogStatus: vi.fn(async () => ({ firstWatchdogClaim: now, lastSuccessfulReview: now })),
  };
}

function observation(kind: OfficialPricingObservation["kind"], retiredAt: string | null = null): OfficialPricingObservation {
  return { kind, retiredAt, sourceDigest: digest, sourceUrl: FUNDED_PRICING_SOURCE_URLS.workers };
}

describe("funded pricing review job", () => {
  const signal = new AbortController().signal;
  const options = (store: FundedPricingReviewJobStore) => ({
    store,
    linear: { notify: vi.fn(async () => undefined), resolve: vi.fn(async () => undefined) },
    now: () => now,
  });

  it("renews only matching pricing and clamps retirement, without replacing inconclusive evidence", async () => {
    const store = jobStore([existing(glm, 2), existing(qwen, 5), existing(gemma, 1)]);
    const opts = options(store);
    await runFundedPricingReview({
      ...opts,
      readOfficial: async () => ({
        [glm]: observation("match", "2026-11-20T00:00:00.000Z"),
        [qwen]: observation("match"),
        [gemma]: observation("inconclusive"),
      }),
    }, signal);
    expect(store.save).toHaveBeenCalledWith(expect.objectContaining({
      modelId: glm, blockedAt: "2026-11-20T00:00:00.000Z", validThrough: "2026-11-20T00:00:00.000Z",
    }), "lease-1");
    expect(store.save).toHaveBeenCalledWith(expect.objectContaining({
      modelId: qwen, blockedAt: null, validThrough: "2026-12-11T00:00:00.000Z",
    }), "lease-1");
    expect(store.save).not.toHaveBeenCalledWith(expect.objectContaining({ modelId: gemma }), expect.anything());
    expect(opts.linear.notify).toHaveBeenCalledWith(expect.objectContaining({ key: gemma, priority: 1 }), signal);
    expect(opts.linear.resolve).toHaveBeenCalledWith(qwen, signal);
    expect(store.finish).toHaveBeenCalledWith("review", "lease-1", now, true);
  });

  it("fences a changed price immediately while preserving the existing deadline", async () => {
    const old = existing(glm, 6);
    const store = jobStore([old]);
    const opts = options(store);
    await runFundedPricingReview({ ...opts, readOfficial: async () => ({ [glm]: observation("changed") }) }, signal);
    expect(store.save).toHaveBeenCalledWith(expect.objectContaining({
      modelId: glm, blockedAt: now.toISOString(), validThrough: old.validThrough,
    }), "lease-1");
    expect(opts.linear.notify).toHaveBeenCalledWith(expect.objectContaining({ key: glm, priority: 1 }), signal);
  });

  it("publishes every verified block before attempting any external alert", async () => {
    const store = jobStore([existing(glm, 4), existing(qwen, 4)]);
    const opts = options(store);
    opts.linear.notify.mockImplementationOnce(async () => {
      expect(store.save).toHaveBeenCalledTimes(2);
      throw new Error("Linear unavailable");
    });
    await expect(runFundedPricingReview({
      ...opts, readOfficial: async () => ({ [glm]: observation("changed"), [qwen]: observation("changed") }),
    }, signal)).rejects.toThrow("Funded pricing review alert delivery failed");
    expect(opts.linear.notify).toHaveBeenCalledTimes(2);
    expect(store.finish).toHaveBeenCalledWith("review", "lease-1", now, false);
  });

  it("separately reports a missing daily run and resolves after a verified heartbeat", async () => {
    const store = jobStore([]);
    const opts = options(store);
    vi.mocked(store.watchdogStatus).mockResolvedValueOnce({
      firstWatchdogClaim: now, lastSuccessfulReview: new Date(now.getTime() - 27 * 3_600_000),
    });
    await runFundedPricingWatchdog(opts, signal);
    expect(opts.linear.notify).toHaveBeenCalledWith(expect.objectContaining({ key: "watchdog", priority: 1 }), signal);
    await runFundedPricingWatchdog(opts, signal);
    expect(opts.linear.resolve).toHaveBeenCalledWith("watchdog", signal);
    expect(store.finish).toHaveBeenCalledWith("watchdog", "lease-1", now, true);
  });

  it("checks a stale heartbeat immediately and preserves first-run grace across a restart", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const store = jobStore([]);
    const opts = options(store);
    vi.mocked(store.watchdogStatus).mockResolvedValueOnce({
      firstWatchdogClaim: now, lastSuccessfulReview: new Date(now.getTime() - 27 * 3_600_000),
    }).mockResolvedValue({ firstWatchdogClaim: now, lastSuccessfulReview: null });
    const startWorker = () => startFundedPricingReviewJob({ ...opts, mode: "watchdog", now: () => new Date() });
    let worker = startWorker();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(opts.linear.notify).toHaveBeenCalledTimes(1);
      opts.linear.notify.mockClear();
      await vi.advanceTimersByTimeAsync(45 * 60_000);
      expect(store.watchdogStatus).toHaveBeenCalledTimes(4);
      expect(opts.linear.notify).not.toHaveBeenCalled();
      await worker.shutdown();
      worker = startWorker();
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(opts.linear.notify).toHaveBeenCalledTimes(1);
    } finally {
      await worker.shutdown();
      vi.useRealTimers();
    }
  });

  it("does not fetch sources or notify when a second replica cannot claim the run", async () => {
    const store = jobStore([]);
    vi.mocked(store.claim).mockResolvedValueOnce(null);
    const opts = options(store);
    const readOfficial = vi.fn(async () => ({}));
    await runFundedPricingReview({ ...opts, readOfficial }, signal);
    expect(readOfficial).not.toHaveBeenCalled();
    expect(opts.linear.notify).not.toHaveBeenCalled();
  });
});
