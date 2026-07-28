export const BILLING_GRACE_PERIOD_MS = 3 * 24 * 60 * 60 * 1000;

export type MatrixBillingPlanSlug = 'matrix_starter' | 'matrix_builder' | 'matrix_max';
export type MatrixBillingInterval = 'monthly' | 'annual';
export type RuntimeCatalogSku = 'starter' | 'builder' | 'max';
export type BillingEntitlementSource = 'stripe' | 'override';
export type BillingEntitlementStatus =
  | 'active'
  | 'trialing'
  | 'past_due'
  | 'canceled'
  | 'incomplete'
  | 'unpaid'
  | 'ended'
  | 'none';

export interface BillingPlanDefinition {
  slug: MatrixBillingPlanSlug;
  marketingName: string;
  monthlyUsd: number;
  annualUsd: number;
  includedRuntimeSlots: number;
  defaultCatalogSku: RuntimeCatalogSku;
  allowedCatalogSkus: RuntimeCatalogSku[];
  rank: number;
}

export interface RuntimeCatalogProfile {
  sku: string;
  label: string;
  provider: 'hetzner';
  serverType: string;
  vcpu: number;
  memoryGb: number;
  diskGb: number;
  active: boolean;
}

export interface RuntimeCatalog {
  profiles: RuntimeCatalogProfile[];
}

export type StripePriceCatalogEntry = {
  kind: 'base_plan';
  planSlug: MatrixBillingPlanSlug;
  interval: MatrixBillingInterval;
};

export interface StripePriceCatalog {
  priceToPlan: Map<string, StripePriceCatalogEntry>;
}

export interface StripeSubscriptionItemProjection {
  priceId: string;
  quantity?: number | null;
}

export interface StripeSubscriptionProjection {
  clerkUserId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  status: BillingEntitlementStatus;
  currentPeriodEnd?: string | null;
  items: StripeSubscriptionItemProjection[];
}

export interface BillingEntitlement {
  clerkUserId: string;
  source: BillingEntitlementSource;
  planSlug: MatrixBillingPlanSlug | 'internal';
  status: BillingEntitlementStatus;
  maxRuntimeSlots: number;
  includedRuntimeSlots: number;
  addonRuntimeSlots: number;
  defaultServerType: string;
  allowedServerTypes: string[];
  stripeSubscriptionId: string | null;
  stripePriceId: string | null;
  gracePeriodEndsAt: string | null;
  effectiveFrom: string;
  effectiveUntil: string | null;
  updatedAt: string;
}

export interface BillingEntitlementOverride {
  id: string;
  clerkUserId: string;
  planSlug: 'internal' | MatrixBillingPlanSlug;
  status: 'active';
  maxRuntimeSlots: number;
  includedRuntimeSlots: number;
  addonRuntimeSlots: number;
  defaultServerType: string;
  allowedServerTypes: string[];
  reason: string;
  createdBy: string;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface RuntimeAccessDecision {
  runtimeProxyAllowed: boolean;
  reason: 'active' | 'grace_period' | 'payment_required' | 'no_entitlement';
  gracePeriodEndsAt?: string | null;
}

export const DEFAULT_BILLING_PLAN_DEFINITIONS: BillingPlanDefinition[] = [
  {
    slug: 'matrix_starter',
    marketingName: 'Starter',
    monthlyUsd: 14,
    annualUsd: 140,
    includedRuntimeSlots: 1,
    defaultCatalogSku: 'starter',
    allowedCatalogSkus: ['starter'],
    rank: 10,
  },
  {
    slug: 'matrix_builder',
    marketingName: 'Builder',
    monthlyUsd: 19,
    annualUsd: 190,
    includedRuntimeSlots: 1,
    defaultCatalogSku: 'builder',
    allowedCatalogSkus: ['starter', 'builder'],
    rank: 20,
  },
  {
    slug: 'matrix_max',
    marketingName: 'Max',
    monthlyUsd: 49,
    annualUsd: 490,
    includedRuntimeSlots: 1,
    defaultCatalogSku: 'max',
    allowedCatalogSkus: ['starter', 'builder', 'max'],
    rank: 30,
  },
];

const DEFAULT_RUNTIME_CATALOG: RuntimeCatalog = {
  profiles: [
    {
      sku: 'starter',
      label: 'Starter',
      provider: 'hetzner',
      serverType: 'cpx22',
      vcpu: 2,
      memoryGb: 4,
      diskGb: 80,
      active: true,
    },
    {
      sku: 'builder',
      label: 'Builder',
      provider: 'hetzner',
      serverType: 'cpx32',
      vcpu: 4,
      memoryGb: 8,
      diskGb: 160,
      active: true,
    },
    {
      sku: 'max',
      label: 'Max',
      provider: 'hetzner',
      serverType: 'cpx52',
      vcpu: 12,
      memoryGb: 24,
      diskGb: 480,
      active: true,
    },
  ],
};

export function loadRuntimeCatalog(env: NodeJS.ProcessEnv): RuntimeCatalog {
  const raw = env.MATRIX_RUNTIME_CATALOG_JSON;
  if (!raw) return DEFAULT_RUNTIME_CATALOG;
  try {
    const parsed = JSON.parse(raw) as Partial<RuntimeCatalog>;
    if (!Array.isArray(parsed.profiles)) return DEFAULT_RUNTIME_CATALOG;
    const profiles = parsed.profiles.filter(isRuntimeCatalogProfile);
    return profiles.length > 0 ? { profiles } : DEFAULT_RUNTIME_CATALOG;
  } catch (err: unknown) {
    if (err instanceof SyntaxError) return DEFAULT_RUNTIME_CATALOG;
    throw err;
  }
}

function isRuntimeCatalogProfile(value: unknown): value is RuntimeCatalogProfile {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<RuntimeCatalogProfile>;
  return (
    typeof candidate.sku === 'string' &&
    typeof candidate.label === 'string' &&
    candidate.provider === 'hetzner' &&
    typeof candidate.serverType === 'string' &&
    typeof candidate.vcpu === 'number' &&
    typeof candidate.memoryGb === 'number' &&
    typeof candidate.diskGb === 'number' &&
    typeof candidate.active === 'boolean'
  );
}

export function loadStripePriceCatalog(env: NodeJS.ProcessEnv): StripePriceCatalog {
  const priceToPlan = new Map<string, StripePriceCatalogEntry>();
  addBasePrice(priceToPlan, env.STRIPE_PRICE_MATRIX_STARTER_MONTHLY, 'matrix_starter', 'monthly');
  addBasePrice(priceToPlan, env.STRIPE_PRICE_MATRIX_STARTER_ANNUAL, 'matrix_starter', 'annual');
  addBasePrice(priceToPlan, env.STRIPE_PRICE_MATRIX_BUILDER_MONTHLY, 'matrix_builder', 'monthly');
  addBasePrice(priceToPlan, env.STRIPE_PRICE_MATRIX_BUILDER_ANNUAL, 'matrix_builder', 'annual');
  addBasePrice(priceToPlan, env.STRIPE_PRICE_MATRIX_MAX_MONTHLY, 'matrix_max', 'monthly');
  addBasePrice(priceToPlan, env.STRIPE_PRICE_MATRIX_MAX_ANNUAL, 'matrix_max', 'annual');
  return { priceToPlan };
}

function addBasePrice(
  map: Map<string, StripePriceCatalogEntry>,
  priceId: string | undefined,
  planSlug: MatrixBillingPlanSlug,
  interval: MatrixBillingInterval,
): void {
  if (!priceId) return;
  map.set(priceId, { kind: 'base_plan', planSlug, interval });
}

export function deriveStripeEntitlement(
  subscription: StripeSubscriptionProjection,
  options: {
    priceCatalog: StripePriceCatalog;
    runtimeCatalog: RuntimeCatalog;
    now: Date;
  },
): BillingEntitlement {
  let selectedPlan: BillingPlanDefinition | undefined;
  let selectedPriceId: string | null = null;

  for (const item of subscription.items) {
    const entry = options.priceCatalog.priceToPlan.get(item.priceId);
    if (!entry) continue;
    const plan = getPlanDefinition(entry.planSlug);
    if (!selectedPlan || plan.rank > selectedPlan.rank) {
      selectedPlan = plan;
      selectedPriceId = item.priceId;
    }
  }

  if (!selectedPlan) {
    return {
      clerkUserId: subscription.clerkUserId,
      source: 'stripe',
      planSlug: 'matrix_starter',
      status: 'none',
      maxRuntimeSlots: 0,
      includedRuntimeSlots: 0,
      addonRuntimeSlots: 0,
      defaultServerType: '',
      allowedServerTypes: [],
      stripeSubscriptionId: subscription.stripeSubscriptionId,
      stripePriceId: null,
      gracePeriodEndsAt: null,
      effectiveFrom: options.now.toISOString(),
      effectiveUntil: null,
      updatedAt: options.now.toISOString(),
    };
  }

  const defaultServerType = resolveServerType(options.runtimeCatalog, selectedPlan.defaultCatalogSku);
  const allowedServerTypes = selectedPlan.allowedCatalogSkus
    .map((sku) => resolveServerType(options.runtimeCatalog, sku))
    .filter((serverType): serverType is string => Boolean(serverType));
  const gracePeriodEndsAt = getGracePeriodEnd(subscription.status, subscription.currentPeriodEnd);

  return {
    clerkUserId: subscription.clerkUserId,
    source: 'stripe',
    planSlug: selectedPlan.slug,
    status: subscription.status,
    maxRuntimeSlots: 1,
    includedRuntimeSlots: selectedPlan.includedRuntimeSlots,
    addonRuntimeSlots: 0,
    defaultServerType: defaultServerType ?? '',
    allowedServerTypes,
    stripeSubscriptionId: subscription.stripeSubscriptionId,
    stripePriceId: selectedPriceId,
    gracePeriodEndsAt,
    effectiveFrom: options.now.toISOString(),
    effectiveUntil: null,
    updatedAt: options.now.toISOString(),
  };
}

function getPlanDefinition(slug: MatrixBillingPlanSlug): BillingPlanDefinition {
  const plan = DEFAULT_BILLING_PLAN_DEFINITIONS.find((candidate) => candidate.slug === slug);
  if (!plan) {
    throw new Error(`Unknown Matrix billing plan: ${slug}`);
  }
  return plan;
}

function resolveServerType(catalog: RuntimeCatalog, sku: string): string | null {
  return catalog.profiles.find((profile) => profile.sku === sku && profile.active)?.serverType ?? null;
}

function getGracePeriodEnd(status: BillingEntitlementStatus, currentPeriodEnd: string | null | undefined): string | null {
  if ((status === 'active' || status === 'trialing') && currentPeriodEnd) {
    return new Date(Date.parse(currentPeriodEnd) + BILLING_GRACE_PERIOD_MS).toISOString();
  }
  if (!currentPeriodEnd) return null;
  if (status === 'past_due' || status === 'unpaid' || status === 'canceled' || status === 'ended') {
    return new Date(Date.parse(currentPeriodEnd) + BILLING_GRACE_PERIOD_MS).toISOString();
  }
  return null;
}

export function getRuntimeAccessDecision(
  entitlement: BillingEntitlement | null | undefined,
  now: Date,
): RuntimeAccessDecision {
  if (!entitlement) return { runtimeProxyAllowed: false, reason: 'no_entitlement' };
  if (entitlement.status === 'active' || entitlement.status === 'trialing') {
    return {
      runtimeProxyAllowed: true,
      reason: 'active',
      gracePeriodEndsAt: entitlement.gracePeriodEndsAt,
    };
  }
  if (entitlement.gracePeriodEndsAt && Date.parse(entitlement.gracePeriodEndsAt) >= now.getTime()) {
    return {
      runtimeProxyAllowed: true,
      reason: 'grace_period',
      gracePeriodEndsAt: entitlement.gracePeriodEndsAt,
    };
  }
  return {
    runtimeProxyAllowed: false,
    reason: 'payment_required',
    gracePeriodEndsAt: entitlement.gracePeriodEndsAt,
  };
}

export function parseBillingEntitlementRecord(record: {
  clerkUserId: string;
  source: string;
  planSlug: string;
  status: string;
  maxRuntimeSlots: number;
  includedRuntimeSlots: number;
  addonRuntimeSlots: number;
  defaultServerType: string;
  allowedServerTypes: string[];
  stripeSubscriptionId: string | null;
  stripePriceId: string | null;
  gracePeriodEndsAt: string | null;
  effectiveFrom: string;
  effectiveUntil: string | null;
  updatedAt: string;
} | null | undefined): BillingEntitlement | null {
  if (!record) return null;
  if (!isEntitlementSource(record.source) || !isPlanSlug(record.planSlug) || !isEntitlementStatus(record.status)) {
    return null;
  }
  return {
    ...record,
    source: record.source,
    planSlug: record.planSlug,
    status: record.status,
  };
}

export function parseBillingOverrideRecord(record: {
  id: string;
  clerkUserId: string;
  planSlug: string;
  status: string;
  maxRuntimeSlots: number;
  includedRuntimeSlots: number;
  addonRuntimeSlots: number;
  defaultServerType: string;
  allowedServerTypes: string[];
  reason: string;
  createdBy: string;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
} | null | undefined): BillingEntitlementOverride | null {
  if (!record) return null;
  if (!isPlanSlug(record.planSlug) || record.status !== 'active') {
    return null;
  }
  return {
    ...record,
    planSlug: record.planSlug,
    status: record.status,
  };
}

export function computeEffectiveEntitlement(input: {
  stripeEntitlement?: BillingEntitlement | null;
  override?: BillingEntitlementOverride | null;
  now: Date;
}): BillingEntitlement | null {
  const override = input.override;
  if (override && !override.revokedAt && (!override.expiresAt || Date.parse(override.expiresAt) > input.now.getTime())) {
    return {
      clerkUserId: override.clerkUserId,
      source: 'override',
      planSlug: override.planSlug,
      status: override.status,
      maxRuntimeSlots: override.maxRuntimeSlots,
      includedRuntimeSlots: override.includedRuntimeSlots,
      addonRuntimeSlots: override.addonRuntimeSlots,
      defaultServerType: override.defaultServerType,
      allowedServerTypes: override.allowedServerTypes,
      stripeSubscriptionId: null,
      stripePriceId: null,
      gracePeriodEndsAt: override.expiresAt,
      effectiveFrom: override.createdAt,
      effectiveUntil: override.expiresAt,
      updatedAt: override.createdAt,
    };
  }
  return input.stripeEntitlement ?? null;
}

function isEntitlementSource(value: string): value is BillingEntitlementSource {
  return value === 'stripe' || value === 'override';
}

function isPlanSlug(value: string): value is BillingEntitlement['planSlug'] {
  return value === 'matrix_starter' || value === 'matrix_builder' || value === 'matrix_max' || value === 'internal';
}

function isEntitlementStatus(value: string): value is BillingEntitlementStatus {
  return (
    value === 'active' ||
    value === 'trialing' ||
    value === 'past_due' ||
    value === 'canceled' ||
    value === 'incomplete' ||
    value === 'unpaid' ||
    value === 'ended' ||
    value === 'none'
  );
}
