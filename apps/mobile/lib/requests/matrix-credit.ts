import { z } from "zod/v4";

import { gatewayRequestUrl } from "./answers";
import { fetchAuthenticatedJson } from "./http";

const CREDIT_UNAVAILABLE_ERROR = "Credit balance unavailable. Try again.";
// A ledger reading older than this is not shown as the current balance.
const MAX_READING_AGE_MS = 5 * 60_000;
// The reading is timed by the server and judged here by the phone's clock.
const CLOCK_SKEW_ALLOWANCE_MS = 60_000;
const MICROUSD_PER_CENT = 10_000;

const MicrousdSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

// The settings snapshot (ProviderSettingsSnapshotSchema in @matrix-os/contracts)
// is large and strict; only the Matrix AI source's ledger reading is read here,
// so a gateway that adds fields elsewhere cannot hide the balance.
const ManagedCreditUsageSchema = z.looseObject({
  kind: z.literal("managed_credit"),
  state: z.enum(["current", "stale"]),
  asOf: z.string().max(64),
  budget: z.looseObject({ remainingBudgetMicrousd: MicrousdSchema }),
  chatAvailability: z.looseObject({
    asOf: z.string().max(64),
    availableBalanceMicrousd: MicrousdSchema,
  }).optional(),
});
const MatrixGatewaySourceSchema = z.looseObject({
  kind: z.literal("matrix_gateway"),
  usage: ManagedCreditUsageSchema,
});
const CreditSnapshotSchema = z.looseObject({
  accessSources: z.array(z.unknown()).max(64),
});

type ManagedCreditUsage = z.infer<typeof ManagedCreditUsageSchema>;

/**
 * What ordinary Chat can spend from this reading, or null when it does not say:
 * no chat funding view, a stale reading, or one that is too old. The amount is
 * the available credit capped by what is left of the monthly budget, as in
 * `gatewayChatAvailableMicrousd` (packages/ui/src/agents-providers/utils.ts).
 */
function chatAvailableMicrousd(usage: ManagedCreditUsage, now: number): number | null {
  const projection = usage.chatAvailability;
  const age = now - Date.parse(usage.asOf);
  if (!projection || projection.asOf !== usage.asOf || usage.state !== "current") return null;
  if (!Number.isFinite(age) || age < -CLOCK_SKEW_ALLOWANCE_MS || age > MAX_READING_AGE_MS) return null;
  return Math.min(projection.availableBalanceMicrousd, usage.budget.remainingBudgetMicrousd);
}

/**
 * The Matrix AI credit this account can spend in Chat right now, in micro-USD,
 * or null when the server does not report one. Read-only.
 */
export async function fetchMatrixCreditBalance(
  clerkToken: string,
  computerGatewayUrl: string,
  now: number = Date.now(),
): Promise<number | null> {
  const url = gatewayRequestUrl(computerGatewayUrl, "/api/ai/provider-settings", {
    includeFundingState: "true",
    includeChatFunding: "true",
  });
  if (!url) throw new Error(CREDIT_UNAVAILABLE_ERROR);
  const snapshot = await fetchAuthenticatedJson({
    url,
    token: clerkToken,
    schema: CreditSnapshotSchema,
    errorMessage: CREDIT_UNAVAILABLE_ERROR,
  });
  for (const candidate of snapshot.accessSources) {
    const source = MatrixGatewaySourceSchema.safeParse(candidate);
    if (!source.success) continue;
    const balance = chatAvailableMicrousd(source.data.usage, now);
    if (balance !== null) return balance;
  }
  return null;
}

function withThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Micro-USD as dollars: 18400000 -> "$18.40". Rounds to the nearest cent, except
 * that an amount below one cent is shown exactly ("$0.0042") so that a little
 * credit does not read as none. Anything that is not a positive amount is "$0.00".
 */
export function formatMicrousd(microusd: number): string {
  const amount = Number.isFinite(microusd) ? Math.trunc(microusd) : 0;
  if (amount <= 0) return "$0.00";
  if (amount < MICROUSD_PER_CENT) {
    return `$0.${String(amount).padStart(6, "0").replace(/0+$/, "")}`;
  }
  const cents = Math.round(amount / MICROUSD_PER_CENT);
  return `$${withThousands(String(Math.floor(cents / 100)))}.${String(cents % 100).padStart(2, "0")}`;
}
