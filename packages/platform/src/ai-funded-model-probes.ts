import { sql } from "kysely";
import { IsoTimestampSchema } from "@matrix-os/contracts";
import { z } from "zod/v4";
import type { PlatformDB } from "./db.js";

export const FUNDED_PROBE_MODELS = ["@cf/zai-org/glm-5.3-flash", "anthropic/claude-sonnet-5"] as const;
type FundedProbeModel = typeof FUNDED_PROBE_MODELS[number];
const MAX_PROBE_RESPONSE_BYTES = 1_024;
const POSITIVE_TTL_MS = 30_000;
const NEGATIVE_TTL_MS = 5_000;
const MAX_PENDING_BUDGET_OPERATIONS = 8;
const MAX_WAITERS_PER_MODEL = 32;
const MAX_CALLER_WINDOW_MS = 6_000;
const pendingBudgetOperations = new Set<Promise<boolean>>();
const ReadyEvidenceSchema = z.object({ ready: z.literal(true), priceValidThrough: IsoTimestampSchema }).strict();

export interface FundedModelProbeResult { ready: boolean; checkedAt: string; staleAfter: string }
export interface FundedModelProbeCall { signal?: AbortSignal; deadlineAtMs?: number }
export interface FundedModelProbeService { probe(modelId: string, call?: FundedModelProbeCall): Promise<FundedModelProbeResult> }

export function loadFundedModelProbeLimits(env: NodeJS.ProcessEnv): { dailyLimit: number; minuteLimit: number } | undefined {
  const dailyLimit = Number(env.MATRIX_FUNDED_AI_MODEL_PROBE_DAILY_LIMIT);
  const minuteLimit = Number(env.MATRIX_FUNDED_AI_MODEL_PROBE_MINUTE_LIMIT);
  if (!Number.isSafeInteger(dailyLimit) || dailyLimit <= 0 || dailyLimit > 10_000
    || !Number.isSafeInteger(minuteLimit) || minuteLimit <= 0 || minuteLimit > 100
    || minuteLimit > dailyLimit) return undefined;
  return { dailyLimit, minuteLimit };
}

/** One conditional UPSERT atomically admits both daily and minute count.
 * PostgreSQL's conflicting-row lock serializes reservations across replicas. */
export async function reserveFundedModelProbe(input: {
  db: PlatformDB; now?: Date; dailyLimit: number; minuteLimit: number; deadlineMs?: number;
}): Promise<boolean> {
  if (!Number.isSafeInteger(input.dailyLimit) || input.dailyLimit <= 0
    || !Number.isSafeInteger(input.minuteLimit) || input.minuteLimit <= 0) return false;
  if (pendingBudgetOperations.size >= MAX_PENDING_BUDGET_OPERATIONS) return false;
  const deadlineMs = Math.min(1_500, Math.max(1, input.deadlineMs ?? 1_500));
  const operation = (async () => {
    await input.db.ready;
    const admitted = await sql`
      with clock as (select coalesce(${input.now?.toISOString() ?? null}::timestamptz, statement_timestamp()) as observed_at),
      bucket as (select to_char(observed_at at time zone 'UTC', 'YYYY-MM-DD') as day_start,
        to_char(observed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI') as minute_start from clock)
      insert into ai_funded_model_probe_budget
        (budget_key, day_start, daily_limit, day_used, minute_start, minute_limit, minute_used)
      select 'global', bucket.day_start, ${input.dailyLimit}, 1, bucket.minute_start, ${input.minuteLimit}, 1 from bucket
      on conflict (budget_key) do update
        set day_start = excluded.day_start,
            daily_limit = excluded.daily_limit,
            day_used = case when ai_funded_model_probe_budget.day_start = excluded.day_start
              then ai_funded_model_probe_budget.day_used + 1 else 1 end,
            minute_start = excluded.minute_start,
            minute_limit = excluded.minute_limit,
            minute_used = case
              when ai_funded_model_probe_budget.minute_start = excluded.minute_start
                then ai_funded_model_probe_budget.minute_used + 1
              else 1
            end
        where (ai_funded_model_probe_budget.day_start < excluded.day_start
          or (ai_funded_model_probe_budget.day_start = excluded.day_start
            and ai_funded_model_probe_budget.daily_limit = excluded.daily_limit
            and ai_funded_model_probe_budget.minute_limit = excluded.minute_limit))
          and (ai_funded_model_probe_budget.day_start < excluded.day_start
            or ai_funded_model_probe_budget.day_used < excluded.daily_limit)
          and (ai_funded_model_probe_budget.minute_start < excluded.minute_start
            or (ai_funded_model_probe_budget.minute_start = excluded.minute_start
              and ai_funded_model_probe_budget.minute_used < excluded.minute_limit))
      returning day_used
    `.execute(input.db.executor);
    return admitted.rows.length === 1;
  })().catch((error: unknown) => {
    console.warn("[funded-ai] Probe budget unavailable:", error instanceof Error ? error.name : typeof error);
    return false;
  });
  pendingBudgetOperations.add(operation);
  void operation.finally(() => { pendingBudgetOperations.delete(operation); });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), deadlineMs);
    })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function readPriceValidThrough(response: Response): Promise<string | undefined> {
  if (!response.ok || !response.body) { await response.body?.cancel(); return undefined; }
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_PROBE_RESPONSE_BYTES) { await reader.cancel(); return undefined; }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
    return ReadyEvidenceSchema.safeParse(value).data?.priceValidThrough;
  } catch (error) {
    console.warn("[funded-ai] Invalid model probe response:", error instanceof Error ? error.name : typeof error);
    return undefined;
  }
}

/** A bounded, operator-funded route probe. Owner policy and ledger are never cached. */
export function createFundedModelProbeService(input: {
  db: PlatformDB;
  relayBaseUrl?: string;
  relayControlToken?: string;
  dailyLimit?: number;
  minuteLimit?: number;
  fetchFn?: typeof fetch;
  now?: () => Date;
  budgetDeadlineMs?: number;
  reserveProbe?: typeof reserveFundedModelProbe;
}): FundedModelProbeService {
  const now = input.now ?? (() => new Date());
  // Keys are restricted to the fixed two-model allowlist, so neither map can grow.
  const cache = new Map<FundedProbeModel, FundedModelProbeResult>();
  interface PendingProbe {
    controller: AbortController;
    waiters: Map<symbol, { deadlineAtMs: number; signal?: AbortSignal }>;
    promise: Promise<FundedModelProbeResult>;
  }
  const inFlight = new Map<FundedProbeModel, PendingProbe>();
  const base = input.relayBaseUrl && URL.canParse(input.relayBaseUrl)
    ? new URL(input.relayBaseUrl) : undefined;
  const enabled = base?.protocol === "https:" && !base.username && !base.password
    && base.pathname === "/" && !base.search && !base.hash
    && !!input.relayControlToken && input.relayControlToken.length >= 32
    && Number.isSafeInteger(input.dailyLimit) && (input.dailyLimit ?? 0) > 0
    && Number.isSafeInteger(input.minuteLimit) && (input.minuteLimit ?? 0) > 0;

  const unavailable = (): FundedModelProbeResult => {
    const checked = now().getTime();
    return { ready: false, checkedAt: new Date(checked).toISOString(), staleAfter: new Date(checked + NEGATIVE_TTL_MS).toISOString() };
  };
  const hasActiveWaiter = (entry: PendingProbe): boolean => {
    const current = Date.now();
    return [...entry.waiters.values()].some((waiter) => current < waiter.deadlineAtMs && !waiter.signal?.aborted);
  };

  function join(model: FundedProbeModel, entry: PendingProbe, call: FundedModelProbeCall): Promise<FundedModelProbeResult> {
    const deadlineAtMs = Math.min(call.deadlineAtMs ?? Date.now() + MAX_CALLER_WINDOW_MS,
      Date.now() + MAX_CALLER_WINDOW_MS);
    if (!Number.isFinite(deadlineAtMs) || deadlineAtMs <= Date.now() || call.signal?.aborted
      || entry.waiters.size >= MAX_WAITERS_PER_MODEL) return Promise.resolve(unavailable());
    const token = Symbol("funded-model-waiter");
    entry.waiters.set(token, { deadlineAtMs, signal: call.signal });
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (result: FundedModelProbeResult) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        call.signal?.removeEventListener("abort", onAbort);
        entry.waiters.delete(token);
        if (entry.waiters.size === 0 && inFlight.get(model) === entry) {
          inFlight.delete(model);
          entry.controller.abort();
        }
        resolve(result);
      };
      const onAbort = () => finish(unavailable());
      call.signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(onAbort, Math.max(0, deadlineAtMs - Date.now()));
      if (call.signal?.aborted) onAbort();
      void entry.promise.then(finish, (error: unknown) => {
        console.warn("[funded-ai] Model probe failed:", error instanceof Error ? error.name : typeof error);
        finish(unavailable());
      });
    });
  }
  return {
    async probe(modelId, call = {}) {
      if (!enabled || !FUNDED_PROBE_MODELS.includes(modelId as FundedProbeModel)) return unavailable();
      if (call.signal?.aborted || (call.deadlineAtMs !== undefined && call.deadlineAtMs <= Date.now())) return unavailable();
      const model = modelId as FundedProbeModel;
      const cached = cache.get(model);
      if (cached && Date.parse(cached.staleAfter) > now().getTime()) return cached;
      const pending = inFlight.get(model);
      if (pending) return join(model, pending, call);
      const entry: PendingProbe = {
        controller: new AbortController(), waiters: new Map(), promise: undefined as unknown as Promise<FundedModelProbeResult>,
      };
      inFlight.set(model, entry);
      entry.promise = (async (): Promise<FundedModelProbeResult> => {
        const admitted = await (input.reserveProbe ?? reserveFundedModelProbe)({ db: input.db,
          dailyLimit: input.dailyLimit!, minuteLimit: input.minuteLimit!, deadlineMs: input.budgetDeadlineMs });
        if (entry.controller.signal.aborted || !hasActiveWaiter(entry)) return unavailable();
        if (!admitted) {
          const result = unavailable();
          cache.set(model, result);
          return result;
        }
        let priceValidThrough: string | undefined;
        try {
          const url = new URL(`/ready?model=${encodeURIComponent(model)}`, base!);
          const response = await (input.fetchFn ?? fetch)(url.toString(), {
            headers: { authorization: `Bearer ${input.relayControlToken}` },
            redirect: "error", signal: AbortSignal.any([entry.controller.signal, AbortSignal.timeout(2_000)]),
          });
          priceValidThrough = await readPriceValidThrough(response);
        } catch (error) {
          console.warn("[funded-ai] Model probe unavailable:", error instanceof Error ? error.name : typeof error);
        }
        const checked = now().getTime();
        if (entry.controller.signal.aborted || !hasActiveWaiter(entry)) return unavailable();
        const priceExpiry = Date.parse(priceValidThrough ?? "");
        const ready = Number.isFinite(priceExpiry) && priceExpiry > checked;
        const result = { ready, checkedAt: new Date(checked).toISOString(),
          staleAfter: new Date(ready ? Math.min(checked + POSITIVE_TTL_MS, priceExpiry)
            : checked + NEGATIVE_TTL_MS).toISOString() };
        cache.set(model, result);
        return result;
      })().finally(() => { if (inFlight.get(model) === entry) inFlight.delete(model); });
      return join(model, entry, call);
    },
  };
}
