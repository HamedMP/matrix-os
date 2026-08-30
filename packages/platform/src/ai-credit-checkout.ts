import { z } from "zod/v4";
import { RuntimeSlotSchema } from "./customer-vps-schema.js";

const StripePriceIdSchema = z.string().min(8).max(255).regex(/^price_[A-Za-z0-9_]+$/);
export const AiCreditPackageIdSchema = z.enum(["usd_5", "usd_10", "usd_25"]);
export type AiCreditPackageId = z.infer<typeof AiCreditPackageIdSchema>;

export const AiCreditCheckoutRequestSchema = z.object({
  packageId: AiCreditPackageIdSchema,
  runtimeSlot: RuntimeSlotSchema.optional().default("primary"),
  requestId: z.uuid(),
}).strict();

export interface AiCreditPackage {
  id: AiCreditPackageId;
  amountUsd: 5 | 10 | 25;
  amountMicrousd: number;
  amountCents: number;
  currency: "usd";
  priceId: string;
}

export type AiCreditCheckoutConfig = { enabled: false } | {
  enabled: true;
  automaticTax: boolean;
  packages: readonly AiCreditPackage[];
};

const PACKAGE_DEFINITIONS = [
  { id: "usd_5", amountUsd: 5, envKey: "STRIPE_PRICE_AI_CREDIT_USD_5" },
  { id: "usd_10", amountUsd: 10, envKey: "STRIPE_PRICE_AI_CREDIT_USD_10" },
  { id: "usd_25", amountUsd: 25, envKey: "STRIPE_PRICE_AI_CREDIT_USD_25" },
] as const;

export const AI_CREDIT_CHECKOUT_KIND = "ai_credit_addon";

export function loadAiCreditCheckoutConfig(env: NodeJS.ProcessEnv): AiCreditCheckoutConfig {
  if (env.MATRIX_FUNDED_AI_ADDON_CHECKOUT_ENABLED !== "true") return { enabled: false };
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) return { enabled: false };
  const configured = PACKAGE_DEFINITIONS.map((definition) => {
    const parsed = StripePriceIdSchema.safeParse(env[definition.envKey]);
    if (!parsed.success) return null;
    return {
      id: definition.id,
      amountUsd: definition.amountUsd,
      amountMicrousd: definition.amountUsd * 1_000_000,
      amountCents: definition.amountUsd * 100,
      currency: "usd" as const,
      priceId: parsed.data,
    };
  });
  // A partially configured catalog creates ambiguous product behavior. Fail
  // closed instead of silently exposing a subset that differs across shells.
  if (configured.some((entry) => entry === null)) return { enabled: false };
  const packages = configured as AiCreditPackage[];
  if (new Set(packages.map((entry) => entry.priceId)).size !== packages.length) {
    throw new Error("Funded AI add-on checkout is misconfigured");
  }
  return {
    enabled: true,
    // Enabling Stripe Tax without active registrations silently collects
    // nothing. Operations must explicitly attest that registrations are live.
    automaticTax: env.MATRIX_AI_CREDIT_STRIPE_TAX_REGISTRATIONS_VERIFIED === "true",
    packages,
  };
}

export function findAiCreditPackage(
  config: AiCreditCheckoutConfig,
  packageId: AiCreditPackageId,
): AiCreditPackage | undefined {
  return config.enabled ? config.packages.find((entry) => entry.id === packageId) : undefined;
}

const AiCreditCheckoutMetadataSchema = z.object({
  matrix_checkout_kind: z.literal(AI_CREDIT_CHECKOUT_KIND),
  matrix_owner_id: z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/),
  matrix_machine_id: z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/),
  matrix_runtime_slot: RuntimeSlotSchema,
  matrix_ai_credit_package_id: AiCreditPackageIdSchema,
  matrix_ai_credit_request_id: z.uuid(),
  matrix_ai_credit_price_id: StripePriceIdSchema,
  matrix_ai_credit_microusd: z.string().regex(/^[1-9][0-9]{0,15}$/),
}).passthrough();

const StripeExpandableIdSchema = z.union([
  z.string().min(3).max(255),
  z.object({ id: z.string().min(3).max(255) }).passthrough(),
]).nullable().optional();

const AiCreditSessionSchema = z.object({
  id: z.string().min(3).max(255).regex(/^cs_[A-Za-z0-9_]+$/),
  mode: z.literal("payment"),
  status: z.enum(["open", "complete", "expired"]),
  payment_status: z.enum(["paid", "unpaid", "no_payment_required"]),
  amount_subtotal: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  amount_total: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  currency: z.literal("usd"),
  client_reference_id: z.string().min(1).max(160),
  payment_intent: StripeExpandableIdSchema,
  metadata: AiCreditCheckoutMetadataSchema,
}).passthrough();

export interface AiCreditCheckoutClaimExpectation {
  requestId: string;
  ownerId: string;
  machineId: string;
  runtimeSlot: string;
  packageId: AiCreditPackageId;
  priceId: string;
  amountMicrousd: number;
  amountCents: number;
  currency: "usd";
}

export interface AiCreditCheckoutSession {
  sessionId: string;
  paymentIntentId: string | null;
  status: "open" | "complete" | "expired";
  paymentStatus: "paid" | "unpaid" | "no_payment_required";
  requestId: string;
  identity: { ownerId: string; machineId: string; runtimeSlot: string };
  packageId: AiCreditPackageId;
  amountMicrousd: number;
}

export function isAiCreditCheckoutObject(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const metadata = (value as { metadata?: unknown }).metadata;
  return Boolean(metadata && typeof metadata === "object"
    && (metadata as { matrix_checkout_kind?: unknown }).matrix_checkout_kind === AI_CREDIT_CHECKOUT_KIND);
}

export function readAiCreditCheckoutRequestId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const parsed = AiCreditCheckoutMetadataSchema.safeParse((value as { metadata?: unknown }).metadata);
  return parsed.success ? parsed.data.matrix_ai_credit_request_id : null;
}

export function assertAiCreditCheckoutMetadata(
  value: unknown,
  claim: AiCreditCheckoutClaimExpectation,
) {
  if (!value || typeof value !== "object") throw new Error("Funded AI checkout metadata is missing");
  const metadata = AiCreditCheckoutMetadataSchema.parse((value as { metadata?: unknown }).metadata);
  if (metadata.matrix_owner_id !== claim.ownerId || metadata.matrix_machine_id !== claim.machineId
    || metadata.matrix_runtime_slot !== claim.runtimeSlot
    || metadata.matrix_ai_credit_request_id !== claim.requestId
    || metadata.matrix_ai_credit_package_id !== claim.packageId
    || metadata.matrix_ai_credit_price_id !== claim.priceId
    || Number(metadata.matrix_ai_credit_microusd) !== claim.amountMicrousd) {
    throw new Error("Funded AI add-on checkout verification failed");
  }
  return metadata;
}

export function parseAiCreditCheckoutSession(
  value: unknown,
  claim: AiCreditCheckoutClaimExpectation,
): AiCreditCheckoutSession {
  const session = AiCreditSessionSchema.parse(value);
  assertAiCreditCheckoutMetadata(value, claim);
  const amountMicrousd = Number(session.metadata.matrix_ai_credit_microusd);
  if (session.client_reference_id !== claim.ownerId
    || amountMicrousd !== claim.amountMicrousd || session.amount_subtotal !== claim.amountCents
    || session.amount_total < session.amount_subtotal
    || session.currency !== claim.currency) {
    throw new Error("Funded AI add-on checkout verification failed");
  }
  return {
    sessionId: session.id,
    paymentIntentId: typeof session.payment_intent === "string"
      ? session.payment_intent
      : session.payment_intent?.id ?? null,
    status: session.status,
    paymentStatus: session.payment_status,
    requestId: session.metadata.matrix_ai_credit_request_id,
    identity: {
      ownerId: session.metadata.matrix_owner_id,
      machineId: session.metadata.matrix_machine_id,
      runtimeSlot: session.metadata.matrix_runtime_slot,
    },
    packageId: claim.packageId,
    amountMicrousd: claim.amountMicrousd,
  };
}
