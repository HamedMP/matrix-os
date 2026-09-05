import {
  MATRIX_HOSTED_BILLING_PLANS,
  MATRIX_HOSTED_BILLING_REGIONS,
  MATRIX_HOSTED_MACHINE_PROFILES,
  type MatrixBillingPublicEntitlement,
  type MatrixHostedBillingRegionSlug,
} from '@matrix-os/contracts';

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
  regionSlug: MatrixHostedBillingRegionSlug | null;
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
  unitAmountMinor?: number | null;
  currency?: string | null;
  interval?: MatrixBillingInterval | null;
  intervalCount?: number | null;
}

export interface StripeSubscriptionProjection {
  clerkUserId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  status: BillingEntitlementStatus;
  currentPeriodEnd?: string | null;
  trialStartedAt?: string | null;
  trialEndsAt?: string | null;
  trialConvertedAt?: string | null;
  firstTrialPaymentFailedAt?: string | null;
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
  billingInterval?: MatrixBillingInterval | null;
  gracePeriodEndsAt: string | null;
  trialStartedAt?: string | null;
  trialEndsAt?: string | null;
  trialConvertedAt?: string | null;
  firstTrialPaymentFailedAt?: string | null;
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

export interface PublicBillingEntitlementDetails {
  recurringPrice?: MatrixBillingPublicEntitlement['recurringPrice'];
  runtimePlacement?: MatrixBillingPublicEntitlement['runtimePlacement'];
}

export function projectPublicBillingEntitlement(
  entitlement: BillingEntitlement,
  runtimeCatalog: RuntimeCatalog,
  details: PublicBillingEntitlementDetails = {},
): MatrixBillingPublicEntitlement {
  const entitledPlan = entitlement.source === 'stripe' && entitlement.planSlug !== 'internal'
    ? getPlanDefinition(entitlement.planSlug)
    : undefined;
  const allowedServerTypes = new Set(entitlement.allowedServerTypes.map((serverType) => serverType.toLowerCase()));
  const candidatePlans = entitledPlan
    ? DEFAULT_BILLING_PLAN_DEFINITIONS
      .filter((plan) => plan.rank <= entitledPlan.rank)
    : DEFAULT_BILLING_PLAN_DEFINITIONS
  const allowedSelections = candidatePlans.flatMap((plan) =>
    MATRIX_HOSTED_BILLING_REGIONS.flatMap((region) => {
      const serverType = resolveServerType(runtimeCatalog, plan.defaultCatalogSku, region.slug);
      if (!serverType || (!entitledPlan && !allowedServerTypes.has(serverType.toLowerCase()))) return [];
      return [{ planSlug: plan.slug, regionSlug: region.slug }];
    }),
  );
  const allowedPlanSlugs = candidatePlans
    .filter((plan) => allowedSelections.some((selection) => selection.planSlug === plan.slug))
    .map((plan) => plan.slug);

  return {
    source: entitlement.source,
    planSlug: entitlement.planSlug,
    status: entitlement.status,
    maxRuntimeSlots: entitlement.maxRuntimeSlots,
    includedRuntimeSlots: entitlement.includedRuntimeSlots,
    addonRuntimeSlots: entitlement.addonRuntimeSlots,
    allowedPlanSlugs,
    allowedSelections,
    portalAvailable: entitlement.source === 'stripe' && entitlement.stripeSubscriptionId !== null,
    billingInterval: entitlement.billingInterval ?? null,
    recurringPrice: details.recurringPrice ?? null,
    runtimePlacement: details.runtimePlacement ?? null,
    gracePeriodEndsAt: entitlement.gracePeriodEndsAt,
    trialStartedAt: entitlement.trialStartedAt ?? null,
    trialEndsAt: entitlement.trialEndsAt ?? null,
    trialConvertedAt: entitlement.trialConvertedAt ?? null,
    firstTrialPaymentFailedAt: entitlement.firstTrialPaymentFailedAt ?? null,
    effectiveFrom: entitlement.effectiveFrom,
    effectiveUntil: entitlement.effectiveUntil,
    updatedAt: entitlement.updatedAt,
  };
}

export const DEFAULT_BILLING_PLAN_DEFINITIONS: BillingPlanDefinition[] =
  MATRIX_HOSTED_BILLING_PLANS.map((plan) => {
    const defaultCatalogSku = plan.slug.replace('matrix_', '') as RuntimeCatalogSku;
    return {
      slug: plan.slug,
      marketingName: plan.label,
      monthlyUsd: plan.monthlyUsd,
      includedRuntimeSlots: 1,
      defaultCatalogSku,
      allowedCatalogSkus: MATRIX_HOSTED_BILLING_PLANS
        .filter((candidate) => candidate.rank <= plan.rank)
        .map((candidate) => candidate.slug.replace('matrix_', '') as RuntimeCatalogSku),
      rank: plan.rank,
    };
  });

const DEFAULT_RUNTIME_CATALOG: RuntimeCatalog = {
  profiles: MATRIX_HOSTED_MACHINE_PROFILES.map((profile) => ({
    sku: profile.planSlug.replace('matrix_', ''),
    label: MATRIX_HOSTED_BILLING_PLANS.find((plan) => plan.slug === profile.planSlug)?.label
      ?? profile.planSlug,
    provider: 'hetzner' as const,
    serverType: profile.serverType,
    vcpu: profile.vcpus,
    memoryGb: profile.memoryGb,
    diskGb: profile.diskGb,
    regionSlug: profile.regionSlug,
    active: true,
  })),
};

export function loadRuntimeCatalog(env: NodeJS.ProcessEnv): RuntimeCatalog {
  const raw = env.MATRIX_RUNTIME_CATALOG_JSON;
  if (!raw) return DEFAULT_RUNTIME_CATALOG;
  try {
    const parsed = JSON.parse(raw) as Partial<RuntimeCatalog>;
    if (!Array.isArray(parsed.profiles)) return DEFAULT_RUNTIME_CATALOG;
    const profiles = parsed.profiles.filter(isRuntimeCatalogProfile).map((profile) => ({
      ...profile,
      regionSlug: profile.regionSlug ?? null,
    }));
    return profiles.length > 0 ? { profiles } : DEFAULT_RUNTIME_CATALOG;
  } catch (err: unknown) {
    if (err instanceof SyntaxError) return DEFAULT_RUNTIME_CATALOG;
    throw err;
  }
}

function isRuntimeCatalogProfile(
  value: unknown,
): value is Omit<RuntimeCatalogProfile, 'regionSlug'> & { regionSlug?: MatrixHostedBillingRegionSlug | null } {
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
    (candidate.regionSlug === null || candidate.regionSlug === undefined || (
      typeof candidate.regionSlug === 'string'
      && ['region_fsn1', 'region_nbg1', 'region_ash', 'region_hil'].includes(candidate.regionSlug)
    )) &&
    typeof candidate.active === 'boolean'
  );
}

export function loadStripePriceCatalog(env: NodeJS.ProcessEnv): StripePriceCatalog {
  const priceToPlan = new Map<string, StripePriceCatalogEntry>();
  for (const entry of parseLegacyStripePriceCatalog(env.STRIPE_LEGACY_PRICE_CATALOG_JSON)) {
    addBasePrice(priceToPlan, entry.priceId, entry.planSlug, entry.interval);
  }
  addBasePrice(priceToPlan, env.STRIPE_PRICE_MATRIX_STARTER_MONTHLY, 'matrix_starter', 'monthly');
  addBasePrice(priceToPlan, env.STRIPE_PRICE_MATRIX_STARTER_ANNUAL, 'matrix_starter', 'annual');
  addBasePrice(priceToPlan, env.STRIPE_PRICE_MATRIX_BUILDER_MONTHLY, 'matrix_builder', 'monthly');
  addBasePrice(priceToPlan, env.STRIPE_PRICE_MATRIX_BUILDER_ANNUAL, 'matrix_builder', 'annual');
  addBasePrice(priceToPlan, env.STRIPE_PRICE_MATRIX_MAX_MONTHLY, 'matrix_max', 'monthly');
  addBasePrice(priceToPlan, env.STRIPE_PRICE_MATRIX_MAX_ANNUAL, 'matrix_max', 'annual');
  return { priceToPlan };
}

function parseLegacyStripePriceCatalog(raw: string | undefined): Array<{
  priceId: string;
  planSlug: MatrixBillingPlanSlug;
  interval: MatrixBillingInterval;
}> {
  if (!raw) return [];
  if (raw.length > 16_384) throw new Error('STRIPE_LEGACY_PRICE_CATALOG_JSON is too large');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    if (err instanceof SyntaxError) throw new Error('STRIPE_LEGACY_PRICE_CATALOG_JSON is invalid');
    throw err;
  }
  if (!Array.isArray(parsed) || parsed.length > 30) {
    throw new Error('STRIPE_LEGACY_PRICE_CATALOG_JSON is invalid');
  }
  return parsed.map((value) => {
    if (!value || typeof value !== 'object') {
      throw new Error('STRIPE_LEGACY_PRICE_CATALOG_JSON is invalid');
    }
    const entry = value as Record<string, unknown>;
    if (
      typeof entry.priceId !== 'string'
      || !/^price_[A-Za-z0-9_]{1,120}$/.test(entry.priceId)
      || !['matrix_starter', 'matrix_builder', 'matrix_max'].includes(String(entry.planSlug))
      || (entry.interval !== 'monthly' && entry.interval !== 'annual')
    ) {
      throw new Error('STRIPE_LEGACY_PRICE_CATALOG_JSON is invalid');
    }
    return {
      priceId: entry.priceId,
      planSlug: entry.planSlug as MatrixBillingPlanSlug,
      interval: entry.interval,
    };
  });
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
  let selectedBillingInterval: MatrixBillingInterval | null = null;

  for (const item of subscription.items) {
    const entry = options.priceCatalog.priceToPlan.get(item.priceId);
    if (!entry) continue;
    const plan = getPlanDefinition(entry.planSlug);
    if (!selectedPlan || plan.rank > selectedPlan.rank) {
      selectedPlan = plan;
      selectedPriceId = item.priceId;
      selectedBillingInterval = entry.interval;
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
      billingInterval: null,
      gracePeriodEndsAt: null,
      trialStartedAt: subscription.trialStartedAt ?? null,
      trialEndsAt: subscription.trialEndsAt ?? null,
      trialConvertedAt: subscription.trialConvertedAt ?? null,
      firstTrialPaymentFailedAt: subscription.firstTrialPaymentFailedAt ?? null,
      effectiveFrom: options.now.toISOString(),
      effectiveUntil: null,
      updatedAt: options.now.toISOString(),
    };
  }

  const defaultServerType = resolveServerType(
    options.runtimeCatalog,
    selectedPlan.defaultCatalogSku,
    'region_fsn1',
  );
  const allowedServerTypes = Array.from(new Set(
    selectedPlan.allowedCatalogSkus.flatMap((sku) => resolveServerTypes(options.runtimeCatalog, sku)),
  ));
  const gracePeriodEndsAt = getGracePeriodEnd(
    subscription.status,
    subscription.currentPeriodEnd,
    Boolean(
      !subscription.trialConvertedAt
      && subscription.trialEndsAt
      && (
        subscription.firstTrialPaymentFailedAt
        || subscription.status === 'canceled'
        || subscription.status === 'unpaid'
        || subscription.status === 'ended'
      )
    ),
  );

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
    billingInterval: selectedBillingInterval,
    gracePeriodEndsAt,
    trialStartedAt: subscription.trialStartedAt ?? null,
    trialEndsAt: subscription.trialEndsAt ?? null,
    trialConvertedAt: subscription.trialConvertedAt ?? null,
    firstTrialPaymentFailedAt: subscription.firstTrialPaymentFailedAt ?? null,
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

export function resolveServerType(
  catalog: RuntimeCatalog,
  sku: string,
  regionSlug: MatrixHostedBillingRegionSlug,
): string | null {
  return catalog.profiles.find(
    (profile) => profile.sku === sku && profile.active && profile.regionSlug === regionSlug,
  )?.serverType ?? catalog.profiles.find(
    (profile) => profile.sku === sku && profile.active && profile.regionSlug === null,
  )?.serverType ?? null;
}

function resolveServerTypes(catalog: RuntimeCatalog, sku: string): string[] {
  return catalog.profiles
    .filter((profile) => profile.sku === sku && profile.active)
    .map((profile) => profile.serverType);
}

function getGracePeriodEnd(
  status: BillingEntitlementStatus,
  currentPeriodEnd: string | null | undefined,
  firstTrialChargeFailed: boolean,
): string | null {
  if (firstTrialChargeFailed || status === 'trialing') return null;
  if (status === 'active' && currentPeriodEnd) {
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
  if (
    entitlement.trialEndsAt
    && !entitlement.trialConvertedAt
    && !entitlement.firstTrialPaymentFailedAt
    && Date.parse(entitlement.trialEndsAt) > now.getTime()
  ) {
    return {
      runtimeProxyAllowed: true,
      reason: 'active',
      gracePeriodEndsAt: null,
    };
  }
  if (entitlement.firstTrialPaymentFailedAt && !entitlement.trialConvertedAt) {
    return {
      runtimeProxyAllowed: false,
      reason: 'payment_required',
      gracePeriodEndsAt: null,
    };
  }
  if (
    entitlement.trialEndsAt
    && !entitlement.trialConvertedAt
    && Date.parse(entitlement.trialEndsAt) <= now.getTime()
  ) {
    return {
      runtimeProxyAllowed: false,
      reason: 'payment_required',
      gracePeriodEndsAt: null,
    };
  }
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
  billingInterval?: MatrixBillingInterval | null;
  gracePeriodEndsAt: string | null;
  trialStartedAt?: string | null;
  trialEndsAt?: string | null;
  trialConvertedAt?: string | null;
  firstTrialPaymentFailedAt?: string | null;
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
      billingInterval: null,
      gracePeriodEndsAt: override.expiresAt,
      trialStartedAt: null,
      trialEndsAt: null,
      trialConvertedAt: null,
      firstTrialPaymentFailedAt: null,
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
