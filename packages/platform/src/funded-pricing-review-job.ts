import { FUNDED_PRICING_CATALOG, type FundedAiPricingReview } from "@matrix-os/contracts";
import {
  FUNDED_PRICING_SOURCE_URLS, readOfficialFundedPricing, type OfficialPricingObservation,
} from "./funded-pricing-review-job-sources.js";
import type { FundedPricingReviewAlert, FundedPricingReviewAlertSink } from "./funded-pricing-review-linear.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const RENEWAL_THRESHOLD = 7 * DAY;
const RENEWAL_PERIOD = 30 * DAY;
const MISSED_THRESHOLD = 26 * HOUR;
const POLL_INTERVAL = 15 * MINUTE;
const RUN_TIMEOUT = 120_000;
type RunKind = "review" | "watchdog";

export interface FundedPricingReviewJobStore {
  list(): Promise<FundedAiPricingReview[]>;
  save(review: FundedAiPricingReview, leaseId: string): Promise<boolean>;
  claim(kind: RunKind, at: Date): Promise<string | null>;
  finish(kind: RunKind, leaseId: string, at: Date, success: boolean): Promise<void>;
  watchdogStatus(): Promise<{ firstWatchdogClaim: Date; lastSuccessfulReview: Date | null }>;
}

export interface FundedPricingReviewJobOptions {
  store: FundedPricingReviewJobStore;
  linear: FundedPricingReviewAlertSink;
  fetchFn?: typeof fetch;
  now?: () => Date;
  readOfficial?: typeof readOfficialFundedPricing;
}

type Result = { update?: FundedAiPricingReview; alert?: FundedPricingReviewAlert };

function alertFor(
  modelId: string, reason: string, sourceUrl: string, deadline: string | null, now: Date,
): FundedPricingReviewAlert {
  const remaining = deadline ? Date.parse(deadline) - now.getTime() : null;
  const priority = remaining === null || remaining <= DAY ? 1 : remaining <= 3 * DAY ? 2 : 3;
  return {
    key: modelId,
    title: `Funded AI pricing review for ${modelId}`,
    description: [
      reason,
      `Model: \`${modelId}\``,
      deadline ? `Deadline: ${deadline} (UTC)` : "No current pricing approval is recorded.",
      `[Official pricing or lifecycle evidence](${sourceUrl})`,
    ].join("\n\n"),
    priority,
    deadline,
  };
}

function reviewModel(
  modelId: string, version: string, old: FundedAiPricingReview | undefined, evidence: OfficialPricingObservation, now: Date,
): Result {
  const previous = old?.version === version ? old : undefined;
  const nowIso = now.toISOString();
  const nowMs = now.getTime();
  const priorRetirement = previous?.blockedAt && previous.blockedAt !== previous.reviewedAt ? previous.blockedAt : null;
  const retirement = evidence.retiredAt ?? priorRetirement;
  const retirementSource = evidence.retirementSourceUrl ?? FUNDED_PRICING_SOURCE_URLS.changelog;
  const deadline = previous?.validThrough ?? null;
  const sourceDigest = evidence.sourceDigest;
  const activeBlock = previous?.blockedAt && previous.blockedAt <= nowIso ? previous.blockedAt : null;

  if (sourceDigest && (evidence.kind === "changed" || (retirement !== null && retirement <= nowIso))) {
    const blockedAt = evidence.kind === "changed" ? nowIso : retirement!;
    const validThrough = deadline && deadline > nowIso ? deadline : nowIso;
    return {
      ...(!activeBlock ? { update: { modelId, version, reviewedAt: nowIso, validThrough, sourceDigest, blockedAt } } : {}),
      alert: alertFor(modelId, evidence.kind === "changed"
        ? "Official token prices differ from the active rate version. New admission has been blocked."
        : "The provider retirement date has passed. New admission has been blocked.",
      evidence.kind === "changed" ? evidence.sourceUrl : retirementSource, blockedAt, now),
    };
  }

  const canRenew = evidence.kind === "match" && sourceDigest !== null;
  if (activeBlock && !canRenew) return {
    alert: alertFor(modelId, "Official pricing evidence is incomplete, inconsistent or unavailable. New admission remains blocked.",
      evidence.sourceUrl, activeBlock, now),
  };

  const currentWindow = deadline ? Date.parse(deadline) - nowMs : Number.NEGATIVE_INFINITY;
  const retireSooner = retirement !== null && (deadline === null || retirement < deadline);
  const retirementChanged = retirement !== (previous?.blockedAt ?? null);
  let update: FundedAiPricingReview | undefined;
  if (canRenew && (currentWindow <= RENEWAL_THRESHOLD || retireSooner || retirementChanged)) {
    const renewed = new Date(nowMs + RENEWAL_PERIOD).toISOString();
    const next = currentWindow <= RENEWAL_THRESHOLD || !retirement ? renewed : deadline ?? renewed;
    const validThrough = retirement && retirement < next ? retirement : next;
    if (validThrough > nowIso && (!previous || validThrough !== deadline || retirementChanged)) {
      update = { modelId, version, reviewedAt: nowIso, validThrough, blockedAt: retirement, sourceDigest };
    }
  } else if (retirement && sourceDigest && deadline && deadline > nowIso && retirementChanged) {
    // Published retirement still takes effect when the price source is inconclusive.
    update = {
      modelId, version, reviewedAt: nowIso, validThrough: retirement < deadline ? retirement : deadline,
      blockedAt: retirement, sourceDigest,
    };
  }

  if (retirement) return {
    update,
    alert: alertFor(modelId, "The provider has announced retirement. Verify a replacement before the deadline.",
      retirementSource, update?.validThrough ?? (deadline && deadline < retirement ? deadline : retirement), now),
  };
  if (!canRenew) return {
    alert: alertFor(modelId, "Official pricing evidence is incomplete, inconsistent or unavailable. The prior approval was not renewed.",
      evidence.sourceUrl, deadline, now),
  };
  return { update };
}

export async function runFundedPricingReview(options: FundedPricingReviewJobOptions, signal: AbortSignal): Promise<void> {
  const now = options.now ?? (() => new Date());
  const leaseId = await options.store.claim("review", now());
  if (!leaseId) return;
  let success = false;
  try {
    const [rows, observations] = await Promise.all([
      options.store.list(), (options.readOfficial ?? readOfficialFundedPricing)({ fetchFn: options.fetchFn, signal }),
    ]);
    const at = now();
    const results: { modelId: string; result: Result }[] = [];
    for (const [modelId, evidence] of Object.entries(observations)) {
      signal.throwIfAborted();
      if (!Object.hasOwn(FUNDED_PRICING_CATALOG, modelId)) throw new Error("Unknown funded pricing review model");
      const previous = rows.find((row) => row.modelId === modelId);
      const result = reviewModel(modelId, FUNDED_PRICING_CATALOG[modelId]!.version, previous, evidence, at);
      if (result.update && !await options.store.save(result.update, leaseId)) {
        throw new Error("Funded pricing review lease lost");
      }
      results.push({ modelId, result });
    }
    signal.throwIfAborted();
    // Persist every eligibility change before any external alert can fail. The
    // immutable managed catalog bounds fanout to at most one operation per model.
    const notifications = await Promise.allSettled(results.map(({ modelId, result }) => result.alert
      ? options.linear.notify(result.alert, signal)
      : options.linear.resolve(modelId, signal)));
    if (notifications.some((result) => result.status === "rejected")) {
      throw new Error("Funded pricing review alert delivery failed");
    }
    success = Object.values(observations).some((evidence) => evidence.sourceDigest !== null);
  } finally {
    await options.store.finish("review", leaseId, now(), success);
  }
}

export async function runFundedPricingWatchdog(options: FundedPricingReviewJobOptions, signal: AbortSignal): Promise<void> {
  const now = options.now ?? (() => new Date());
  const at = now();
  const leaseId = await options.store.claim("watchdog", at);
  if (!leaseId) return;
  let success = false;
  try {
    const { firstWatchdogClaim, lastSuccessfulReview: last } = await options.store.watchdogStatus();
    signal.throwIfAborted();
    const missed = last
      ? last > at || at.getTime() - last.getTime() >= MISSED_THRESHOLD
      : at.getTime() - firstWatchdogClaim.getTime() >= HOUR;
    if (missed) {
      await options.linear.notify({
        key: "watchdog", title: "Funded AI pricing review missed its daily run", priority: 1,
        description: last
          ? `Last successful pricing review: ${last.toISOString()} (UTC). Check the Platform pricing review worker and provider evidence.`
          : "No successful pricing review is recorded. Check the Platform pricing review worker and provider evidence.",
      }, signal);
    } else if (last) {
      await options.linear.resolve("watchdog", signal);
    }
    success = true;
  } finally {
    await options.store.finish("watchdog", leaseId, now(), success);
  }
}

export function startFundedPricingReviewJob(
  options: FundedPricingReviewJobOptions & { mode?: RunKind | "both" },
): { shutdown(): Promise<void> } {
  const lifetime = new AbortController();
  const running: Partial<Record<RunKind, Promise<void>>> = {};
  const mode = options.mode ?? "both";
  const run = (kind: RunKind): void => {
    if (lifetime.signal.aborted || running[kind]) return;
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(RUN_TIMEOUT)]);
    const job = kind === "review"
      ? runFundedPricingReview(options, signal)
      : runFundedPricingWatchdog(options, signal);
    running[kind] = job.catch((error: unknown) => {
      if (!lifetime.signal.aborted) {
        console.warn("[funded-ai] pricing review worker failed", kind, error instanceof Error ? error.name : "UnknownError");
      }
    }).finally(() => { delete running[kind]; });
  };

  const timers: NodeJS.Timeout[] = [];
  if (mode === "review" || mode === "both") {
    run("review");
    timers.push(setInterval(() => run("review"), POLL_INTERVAL).unref());
  }
  if (mode === "watchdog" || mode === "both") {
    run("watchdog");
    timers.push(setInterval(() => run("watchdog"), POLL_INTERVAL).unref());
  }

  return {
    async shutdown() {
      lifetime.abort();
      for (const timer of timers) clearInterval(timer);
      await Promise.all(Object.values(running));
    },
  };
}
