"use client";

import { useAuth } from "@clerk/nextjs";
import { useEffect, useMemo, useState } from "react";
import { hasMatrixBillingAccess } from "@/lib/billing";

const BILLING_STATUS_TIMEOUT_MS = 10_000;
const BILLING_STATUS_CACHE_TTL_MS = 30_000;
const BILLING_STATUS_RETRY_MS = 3_000;
const PLATFORM_SESSION_BILLING_CACHE_KEY = "platform-session";

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
  accessReason: string | null;
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
  gracePeriodEndsAt: string | null;
  effectiveFrom: string;
  effectiveUntil: string | null;
  updatedAt: string;
};

type BillingAccessRemoteState = {
  active: boolean;
  entitlement: BillingEntitlementSummary | null;
  accessReason: string | null;
};

export function useMatrixBillingAccess(): BillingAccessState {
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
      setRemoteState({ active: false, entitlement: null, accessReason: null });
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
        if (checkoutReturnRequested && !state.active) {
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

  if (!isLoaded) return { active: null, checking: true, entitlement: null, accessReason: null };
  if (legacyActive) return { active: true, checking: false, entitlement: null, accessReason: "legacy_clerk_plan" };
  if (!remoteChecked) return { active: null, checking: true, entitlement: null, accessReason: null };
  return {
    active: remoteState?.active === true,
    checking: false,
    entitlement: remoteState?.entitlement ?? null,
    accessReason: remoteState?.accessReason ?? null,
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
    .then(async (response) => {
      if (response.status >= 500 || response.status === 429) {
        throw new Error("billing_status_retryable");
      }
      if (!response.ok) return { active: false, entitlement: null, accessReason: null };
      const body = (await response.json()) as {
        access?: { runtimeProxyAllowed?: boolean; reason?: string };
        entitlement?: BillingEntitlementSummary | null;
      };
      return {
        active: body.access?.runtimeProxyAllowed === true,
        entitlement: body.entitlement ?? null,
        accessReason: typeof body.access?.reason === "string" ? body.access.reason : null,
      };
    })
    .then((state) => {
      if (!options.skipCache && (state.active || !options.skipInactiveCache)) {
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
