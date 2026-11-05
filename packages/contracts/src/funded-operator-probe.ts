import { z } from 'zod/v4';
const amount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const count = z.number().int().nonnegative().max(10_000_000);
const identifier = z.string().min(1).max(160);
export const OperatorProbeHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const rates = {
  inputRateThousandths: amount, outputRateThousandths: amount, cacheReadRateThousandths: amount,
  cacheWrite5mRateThousandths: amount, cacheWrite1hRateThousandths: amount,
};
export const OperatorProbeUsageSchema = z.strictObject({ inputTokens: count, outputTokens: count,
  cacheReadTokens: count, cacheWrite5mTokens: count, cacheWrite1hTokens: count });
export type OperatorProbeUsage = z.infer<typeof OperatorProbeUsageSchema>;
const policyShape = z.strictObject({ canonicalModelId: identifier, nativeModelId: identifier,
  pricingVersion: identifier, pricingValidThrough: z.iso.datetime(), requestFingerprint: OperatorProbeHashSchema,
  maximumInputTokens: count.positive(), maximumOutputTokens: z.literal(1), ...rates,
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
export const OperatorProbeFinalizeSchema = z.strictObject({ protocolVersion: z.literal(1), probeId: z.uuid(),
  executionId: z.uuid(), economicHash: OperatorProbeHashSchema, outcome: z.enum(['ready', 'not_ready', 'unknown']),
  usage: OperatorProbeUsageSchema.nullable(), providerReferenceHash: OperatorProbeHashSchema.nullable() });
export type OperatorProbeFinalizeInput = z.infer<typeof OperatorProbeFinalizeSchema>;
export const OperatorProbeAttemptLookupSchema = z.strictObject({ probeId: z.uuid() });
export const OperatorProbeBudgetConfigSchema = z.strictObject({ budgetId: identifier,
  allocationMicrousd: amount.positive(), historicalReserveMicrousd: amount, historicalUnpriced: z.boolean(),
  enabled: z.boolean(), expiresAt: z.iso.datetime(), revision: identifier, source: identifier,
  policies: z.array(OperatorProbePolicySchema).min(1).max(100) }).refine(c =>
  c.historicalReserveMicrousd <= c.allocationMicrousd && new Set(c.policies.map(p => p.canonicalModelId)).size === c.policies.length);
export type OperatorProbeBudgetConfig = z.infer<typeof OperatorProbeBudgetConfigSchema>;
export interface OperatorProbeReceipt {
  receiptHash: string; payloadHash: string; status: 'unknown' | 'settled' | 'discrepancy';
  outcome: OperatorProbeFinalizeInput['outcome']; costMicrousd: number | null;
  usage: OperatorProbeUsage | null; providerReferenceHash: string | null; finalizedAt: string;
}
export interface OperatorProbeAttempt {
  protocolVersion: 1; probeId: string; executionId: string; policy: OperatorProbePolicy; economicHash: string;
  status: 'started' | OperatorProbeReceipt['status']; startedAt: string; receipt: OperatorProbeReceipt | null;
}
export interface OperatorProbeBudgetStatus extends OperatorProbeBudgetConfig {
  heldMicrousd: number; settledMicrousd: number; frozen: boolean; attemptCount: number; availableMicrousd: number;
}
export interface OperatorProbeBudgetStore {
  begin(input: OperatorProbeBeginInput): Promise<{ dispatchGranted: boolean; attempt: OperatorProbeAttempt }>;
  finalize(input: OperatorProbeFinalizeInput): Promise<OperatorProbeReceipt>;
  getAttempt(probeId: string): Promise<OperatorProbeAttempt | null>;
  getStatus(): Promise<OperatorProbeBudgetStatus | null>;
}
