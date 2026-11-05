import { z } from 'zod/v4';
const amount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const admissionCount = z.number().int().nonnegative().max(10_000_000);
// Reports must reach discrepancy handling even when they exceed an admission ceiling.
const observedCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const identifier = z.string().min(1).max(160);
export const OperatorProbeHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const rates = {
  inputRateThousandths: amount, outputRateThousandths: amount, cacheReadRateThousandths: amount,
  cacheWrite5mRateThousandths: amount, cacheWrite1hRateThousandths: amount,
};
export const OperatorProbeUsageSchema = z.strictObject({ inputTokens: observedCount, outputTokens: observedCount,
  cacheReadTokens: observedCount, cacheWrite5mTokens: observedCount, cacheWrite1hTokens: observedCount });
export type OperatorProbeUsage = z.infer<typeof OperatorProbeUsageSchema>;
const policyShape = z.strictObject({ canonicalModelId: identifier, nativeModelId: identifier,
  pricingVersion: identifier, pricingValidThrough: z.iso.datetime(), requestFingerprint: OperatorProbeHashSchema,
  maximumInputTokens: admissionCount.positive(), maximumOutputTokens: z.literal(1), ...rates,
  maximumCostMicrousd: amount.positive() });
export type OperatorProbePolicy = z.infer<typeof policyShape>;
function checked(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Unsupported probe cost');
  return Number(value);
}
/** Full provider context, highest supported input rate, 120% margin. No tokenizer assumption. */
export function quoteOperatorProbeMicrousd(policy: OperatorProbePolicy): number {
  const rate = Math.max(policy.inputRateThousandths, policy.cacheReadRateThousandths,
    policy.cacheWrite5mRateThousandths, policy.cacheWrite1hRateThousandths);
  return checked(((BigInt(policy.maximumInputTokens) * BigInt(rate)
    + BigInt(policy.maximumOutputTokens) * BigInt(policy.outputRateThousandths)) * 120n + 99_999n) / 100_000n);
}
export function priceOperatorProbeUsageMicrousd(policy: OperatorProbePolicy, usage: OperatorProbeUsage): number {
  OperatorProbeUsageSchema.parse(usage);
  const total = BigInt(usage.inputTokens) * BigInt(policy.inputRateThousandths)
    + BigInt(usage.outputTokens) * BigInt(policy.outputRateThousandths)
    + BigInt(usage.cacheReadTokens) * BigInt(policy.cacheReadRateThousandths)
    + BigInt(usage.cacheWrite5mTokens) * BigInt(policy.cacheWrite5mRateThousandths)
    + BigInt(usage.cacheWrite1hTokens) * BigInt(policy.cacheWrite1hRateThousandths);
  return checked((total + 999n) / 1000n);
}
export const OperatorProbePolicySchema = policyShape.superRefine((policy, ctx) => {
  try { if (quoteOperatorProbeMicrousd(policy) <= policy.maximumCostMicrousd) return; }
  catch (error: unknown) {
    if (!(error instanceof Error)) throw error;
    ctx.addIssue({ code: 'custom', message: 'Unsupported probe cost bounds' }); return;
  }
  ctx.addIssue({ code: 'custom', message: 'Insufficient conservative probe maximum' });
});
export const OperatorProbeBeginSchema = z.strictObject({ protocolVersion: z.literal(1), probeId: z.uuid(),
  executionId: z.uuid(), policy: OperatorProbePolicySchema });
export type OperatorProbeBeginInput = z.infer<typeof OperatorProbeBeginSchema>;
const providerLogId = z.string().regex(/^(?:[a-f0-9]{32}|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/i).optional();
export const OperatorProbeFinalizeSchema = z.strictObject({ protocolVersion: z.literal(1), probeId: z.uuid(),
  executionId: z.uuid(), economicHash: OperatorProbeHashSchema, outcome: z.enum(['ready', 'not_ready', 'unknown']),
  usage: OperatorProbeUsageSchema.nullable(), providerReferenceHash: OperatorProbeHashSchema.nullable(), providerLogId });
export type OperatorProbeFinalizeInput = z.infer<typeof OperatorProbeFinalizeSchema>;
export const OperatorProbeAttemptLookupSchema = z.strictObject({ probeId: z.uuid() });
export const OperatorProbeBudgetConfigSchema = z.strictObject({ budgetId: identifier,
  allocationMicrousd: amount.positive(), historicalReserveMicrousd: amount, historicalUnpriced: z.boolean(),
  enabled: z.boolean(), expiresAt: z.iso.datetime(), revision: identifier, source: identifier,
  policies: z.array(OperatorProbePolicySchema).min(1).max(100) }).refine(c =>
  c.historicalReserveMicrousd <= c.allocationMicrousd && new Set(c.policies.map(p => p.canonicalModelId)).size === c.policies.length);
export type OperatorProbeBudgetConfig = z.infer<typeof OperatorProbeBudgetConfigSchema>;
export const OperatorProbeReceiptSchema = z.strictObject({
  receiptHash: OperatorProbeHashSchema, payloadHash: OperatorProbeHashSchema,
  status: z.enum(['unknown', 'settled', 'discrepancy']), outcome: OperatorProbeFinalizeSchema.shape.outcome,
  costMicrousd: amount.nullable(), usage: OperatorProbeUsageSchema.nullable(),
  providerReferenceHash: OperatorProbeHashSchema.nullable(), providerLogId, finalizedAt: z.iso.datetime(),
});
export type OperatorProbeReceipt = z.infer<typeof OperatorProbeReceiptSchema>;
export const OperatorProbeAttemptSchema = OperatorProbeBeginSchema.extend({ economicHash: OperatorProbeHashSchema,
  status: z.enum(['started', 'unknown', 'settled', 'discrepancy']), startedAt: z.iso.datetime(),
  receipt: OperatorProbeReceiptSchema.nullable() });
export type OperatorProbeAttempt = z.infer<typeof OperatorProbeAttemptSchema>;
export const OperatorProbeGrantSchema = z.strictObject({ dispatchGranted: z.boolean(), attempt: OperatorProbeAttemptSchema });
export const OperatorProbeBudgetStatusSchema = OperatorProbeBudgetConfigSchema.safeExtend({
  heldMicrousd: amount, settledMicrousd: amount, frozen: z.boolean(), attemptCount: amount, availableMicrousd: amount,
});
export type OperatorProbeBudgetStatus = z.infer<typeof OperatorProbeBudgetStatusSchema>;
export const OperatorProbeRequestSchema = z.strictObject({ protocolVersion: z.literal(1), probeId: z.uuid(), model: identifier });
export interface OperatorProbeBudgetStore {
  begin(input: OperatorProbeBeginInput): Promise<{ dispatchGranted: boolean; attempt: OperatorProbeAttempt }>;
  finalize(input: OperatorProbeFinalizeInput): Promise<OperatorProbeReceipt>;
  getAttempt(probeId: string): Promise<OperatorProbeAttempt | null>;
  getStatus(): Promise<OperatorProbeBudgetStatus | null>;
}

export function normalizeOperatorServiceOrigin(raw: string): string {
  const exactOrigin = /^(https?):\/\/([^/?#]*)(.*)$/i.exec(raw);
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    if (error instanceof TypeError) throw new Error("PLATFORM_INTERNAL_URL must be a valid URL");
    throw error;
  }
  const rawAuthority = exactOrigin?.[2] ?? "";
  const rawSuffix = exactOrigin?.[3] ?? "";
  const closingBracket = rawAuthority.indexOf("]");
  const rawHostname = rawAuthority.startsWith("[") && closingBracket >= 0
    ? rawAuthority.slice(0, closingBracket + 1).toLowerCase()
    : (rawAuthority.split(":", 1)[0] ?? "").toLowerCase();
  const isExactLoopback = rawHostname === "127.0.0.1"
    || rawHostname === "[::1]";
  if (!exactOrigin
    || !(["http:", "https:"] as const).includes(url.protocol as "http:" | "https:")
    || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== ""
    || (rawSuffix !== "" && rawSuffix !== "/")
    || (url.protocol === "http:" && !isExactLoopback)) {
    throw new Error(
      "PLATFORM_INTERNAL_URL must be an HTTPS origin or a literal loopback HTTP origin without credentials or a path",
    );
  }
  return url.origin;
}

/** All callers supply a finite fetch deadline covering body reads as well as headers. */
export async function readOperatorProbeJson(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.body) throw new Error('Missing probe response');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, chunks = 0, text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes || ++chunks > 4096) throw new Error('Oversized probe response');
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
}

export function operatorProbeRpc(origin: string, base: string, token: string, fetchFn: typeof fetch, headers?: Record<string, string>) {
  const url = normalizeOperatorServiceOrigin(origin) + base;
  return async <T>(action: string, body: unknown, schema: z.ZodType<T>, timeoutMs = 3000): Promise<T> => {
    const response = await fetchFn(url + '/' + action, {
      method: body === undefined ? 'GET' : 'POST', headers: { ...headers, authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify(body), cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error('Operator probe control unavailable');
    }
    return schema.parse(await readOperatorProbeJson(response, 128 * 1024));
  };
}
