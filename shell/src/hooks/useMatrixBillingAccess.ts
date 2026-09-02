"use client";

import { useAuth } from "@clerk/nextjs";
import { useEffect, useMemo, useState } from "react";
import { hasMatrixBillingAccess } from "@/lib/billing";

const BILLING_STATUS_TIMEOUT_MS = 10_000;
const BILLING_STATUS_CACHE_TTL_MS = 30_000;
const BILLING_STATUS_RETRY_MS = 3_000;
const PLATFORM_SESSION_BILLING_CACHE_KEY = "platform-session";
const APP_SESSION_STALE_AUTH_FAILURE = "app-session-stale";
const e2eBillingBypass = process.env.NEXT_PUBLIC_E2E_TEST_BYPASS === "1";

type BillingStatusSnapshot = {
  cacheKey: string;
  state: BillingAccessRemoteState;
  checkedAt: number;
};

let billingStatusSnapshot: BillingStatusSnapshot | null = null;
let billingStatusRequest: { cacheKey: string; promise: Promise<BillingAccessRemoteState> } | null = null;

type BillingAccessState = {
  active: boolean | null;
  checking: boolean;
  entitlement: BillingEntitlementSummary | null;
  trialOffer: BillingTrialOffer | null;
  accessReason: string | null;
  accessIssue: BillingAccessIssue;
};

export type BillingAccessIssue = "auth" | null;

export type BillingTrialOffer = {
  eligible: boolean;
  durationDays: number;
};

export type BillingEntitlementSummary = {
  source: "stripe" | "override";
  planSlug: "matrix_starter" | "matrix_builder" | "matrix_max" | "internal";
  status: string;
  maxRuntimeSlots: number;
  includedRuntimeSlots: number;
  addonRuntimeSlots: number;
  defaultServerType: string;
  allowedServerTypes: string[];
  stripeSubscriptionId: string | null;
  stripePriceId: string | null;
  billingInterval?: "monthly" | "annual" | null;
  gracePeriodEndsAt: string | null;
  trialStartedAt?: string | null;
  trialEndsAt?: string | null;
  trialConvertedAt?: string | null;
  firstTrialPaymentFailedAt?: string | null;
  effectiveFrom: string;
  effectiveUntil: string | null;
  updatedAt: string;
};

type BillingAccessRemoteState = {
  active: boolean | null;
  entitlement: BillingEntitlementSummary | null;
  trialOffer: BillingTrialOffer | null;
  accessReason: string | null;
  accessIssue: BillingAccessIssue;
};

export function useMatrixBillingAccess(): BillingAccessState {
  const state = useManagedMatrixBillingAccess();
  const e2eBillingScenario = e2eBillingBypass
    && typeof window !== "undefined"
    ? new URLSearchParams(window.location.search).get("e2e_billing_state")
    : null;
  if (!e2eBillingBypass) return state;
  if (e2eBillingScenario === "legacy-trial") {
    return {
      active: true,
      checking: false,
      entitlement: {
        source: "stripe",
        planSlug: "matrix_builder",
        status: "trialing",
        maxRuntimeSlots: 1,
        includedRuntimeSlots: 1,
        addonRuntimeSlots: 0,
        defaultServerType: "cpx32",
        allowedServerTypes: ["cpx22", "cpx32"],
        stripeSubscriptionId: "sub_legacy_trial",
        stripePriceId: "price_legacy_builder_monthly",
        billingInterval: "monthly",
        gracePeriodEndsAt: null,
        trialStartedAt: "2026-08-29T00:00:00.000Z",
        trialEndsAt: "2026-09-01T00:00:00.000Z",
        trialConvertedAt: null,
        firstTrialPaymentFailedAt: null,
        effectiveFrom: "2026-08-29T00:00:00.000Z",
        effectiveUntil: null,
        updatedAt: "2026-08-29T00:00:00.000Z",
      },
      trialOffer: { eligible: false, durationDays: 3 },
      accessReason: "e2e_legacy_trial",
      accessIssue: null,
    };
  }
  return {
    active: false,
    checking: false,
    entitlement: null,
    // Keep browser screenshots deterministic while exercising the same
    // three-day offer shown to eligible first-time hosted customers.
    trialOffer: { eligible: true, durationDays: 3 },
    accessReason: "e2e_test_bypass",
    accessIssue: null,
  };
}

function useManagedMatrixBillingAccess(): BillingAccessState {
  const { isLoaded, isSignedIn, has, userId } = useAuth();
  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- returned hook API / stable identity for effect dep
  const legacyActive = useMemo(
    () => (isLoaded && isSignedIn ? hasMatrixBillingAccess(has) : false),
    [has, isLoaded, isSignedIn],
  );
  const [remoteState, setRemoteState] = useState<BillingAccessRemoteState | null>(null);
  const [remoteChecked, setRemoteChecked] = useState(false);
  const [retryTick, setRetryTick] = useState(0);

  // react-doctor-disable-next-line react-doctor/no-cascading-set-state -- the setRemoteState/setRemoteChecked pairs live in mutually-exclusive branches (auth-gate, missing-userId, cache-hit, async fetch then/catch) representing a single load's loading -> result transition; they are not a synchronous render cascade and combining them across branches would obscure the distinct cases
  useEffect(() => {
    if (!isLoaded || legacyActive) {
      // react-doctor-disable-next-line react-hooks-js/set-state-in-effect -- async billing-status load hook: it reads Clerk auth + a module-level cache and otherwise fetches /billing/status, setting remoteState/remoteChecked from the (async) result; the value cannot be derived in render
      setRemoteState(null);
      setRemoteChecked(!isLoaded || legacyActive);
      return;
    }
    if (isSignedIn && !userId) {
      setRemoteState({ active: false, entitlement: null, trialOffer: null, accessReason: null, accessIssue: null });
      setRemoteChecked(true);
      return;
    }
    const billingCacheKey = isSignedIn ? userId : PLATFORM_SESSION_BILLING_CACHE_KEY;
    const shouldUseSnapshotCache = isSignedIn;
    const checkoutReturnRequested = isCheckoutSuccessReturn();
    const cached = checkoutReturnRequested || !shouldUseSnapshotCache
      ? null
      : readCachedBillingStatus(billingCacheKey);
    if (cached !== null) {
      setRemoteState(cached);
      setRemoteChecked(true);
      return;
    }
    let disposed = false;
    let retryTimeoutId: number | undefined;
    setRemoteChecked(false);
    readRemoteBillingStatus(billingCacheKey, {
      skipCache: !shouldUseSnapshotCache,
      skipInactiveCache: checkoutReturnRequested,
    })
      .then((state) => {
        if (disposed) return;
        setRemoteState(state);
        setRemoteChecked(true);
        if (state.accessIssue === "auth" || (checkoutReturnRequested && state.active === false)) {
          retryTimeoutId = window.setTimeout(() => {
            setRetryTick((current) => current + 1);
          }, BILLING_STATUS_RETRY_MS);
        }
      })
      .catch((error: unknown) => {
        if (disposed) return;
        console.warn("[billing] unable to read Stripe billing status", error);
        setRemoteState(null);
        setRemoteChecked(false);
        retryTimeoutId = window.setTimeout(() => {
          setRetryTick((current) => current + 1);
        }, BILLING_STATUS_RETRY_MS);
      });
    return () => {
      disposed = true;
      if (retryTimeoutId !== undefined) window.clearTimeout(retryTimeoutId);
    };
  }, [isLoaded, isSignedIn, legacyActive, retryTick, userId]);

  if (!isLoaded) return { active: null, checking: true, entitlement: null, trialOffer: null, accessReason: null, accessIssue: null };
  if (legacyActive) {
    return {
      active: true,
      checking: false,
      entitlement: null,
      trialOffer: null,
      accessReason: "legacy_clerk_plan",
      accessIssue: null,
    };
  }
  if (remoteState?.accessIssue === "auth") {
    return {
      active: null,
      checking: true,
      entitlement: null,
      trialOffer: null,
      accessReason: remoteState.accessReason,
      accessIssue: "auth",
    };
  }
  if (!remoteChecked) return { active: null, checking: true, entitlement: null, trialOffer: null, accessReason: null, accessIssue: null };
  return {
    active: remoteState?.active === true,
    checking: false,
    entitlement: remoteState?.entitlement ?? null,
    trialOffer: remoteState?.trialOffer ?? null,
    accessReason: remoteState?.accessReason ?? null,
    accessIssue: null,
  };
}

export function resetMatrixBillingAccessCacheForTests(): void {
  billingStatusSnapshot = null;
  billingStatusRequest = null;
}

function readCachedBillingStatus(cacheKey: string): BillingAccessRemoteState | null {
  if (!billingStatusSnapshot || billingStatusSnapshot.cacheKey !== cacheKey) return null;
  if (Date.now() - billingStatusSnapshot.checkedAt > BILLING_STATUS_CACHE_TTL_MS) return null;
  return billingStatusSnapshot.state;
}

function isCheckoutSuccessReturn(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("checkout") === "success";
}

function readRemoteBillingStatus(
  cacheKey: string,
  options: { skipCache?: boolean; skipInactiveCache?: boolean } = {},
): Promise<BillingAccessRemoteState> {
  if (billingStatusRequest?.cacheKey === cacheKey) return billingStatusRequest.promise;

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), BILLING_STATUS_TIMEOUT_MS);
  const promise = fetch("/billing/status", {
    method: "GET",
    credentials: "include",
    headers: { accept: "application/json" },
    cache: "no-store",
    signal: controller.signal,
  })
    .then(async (response): Promise<BillingAccessRemoteState> => {
      if (response.status >= 500 || response.status === 429) {
        throw new Error("billing_status_retryable");
      }
      if (response.status === 401 || response.status === 403) {
        if (response.headers.get("x-auth-failure") !== APP_SESSION_STALE_AUTH_FAILURE) {
          return { active: false, entitlement: null, trialOffer: null, accessReason: null, accessIssue: null };
        }
        return {
          active: null,
          entitlement: null,
          trialOffer: null,
          accessReason: "auth_session_refreshing",
          accessIssue: "auth",
        };
      }
      if (!response.ok) {
        return { active: false, entitlement: null, trialOffer: null, accessReason: null, accessIssue: null };
      }
      const body = (await response.json()) as {
        access?: { runtimeProxyAllowed?: boolean; reason?: string };
        entitlement?: BillingEntitlementSummary | null;
        trialOffer?: { eligible?: unknown; durationDays?: unknown };
      };
      return {
        active: body.access?.runtimeProxyAllowed === true,
        entitlement: body.entitlement ?? null,
        trialOffer: parseBillingTrialOffer(body.trialOffer),
        accessReason: typeof body.access?.reason === "string" ? body.access.reason : null,
        accessIssue: null,
      };
    })
    .then((state) => {
      if (!options.skipCache && state.accessIssue === null && (state.active || !options.skipInactiveCache)) {
        billingStatusSnapshot = { cacheKey, state, checkedAt: Date.now() };
      }
      return state;
    })
    .finally(() => {
      window.clearTimeout(timeoutId);
      if (billingStatusRequest?.promise === promise) billingStatusRequest = null;
    });

  billingStatusRequest = { cacheKey, promise };
  return promise;
}

function parseBillingTrialOffer(value: {
  eligible?: unknown;
  durationDays?: unknown;
} | undefined): BillingTrialOffer | null {
  if (
    typeof value?.eligible !== "boolean"
    || typeof value.durationDays !== "number"
    || !Number.isInteger(value.durationDays)
    || value.durationDays <= 0
    || value.durationDays > 30
  ) {
    return null;
  }
  return { eligible: value.eligible, durationDays: value.durationDays };
}
