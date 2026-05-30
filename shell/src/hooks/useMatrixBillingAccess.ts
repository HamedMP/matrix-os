"use client";

import { useAuth } from "@clerk/nextjs";
import { useEffect, useMemo, useState } from "react";
import { hasMatrixBillingAccess } from "@/lib/billing";

const BILLING_STATUS_TIMEOUT_MS = 10_000;
const BILLING_STATUS_CACHE_TTL_MS = 30_000;
const BILLING_STATUS_RETRY_MS = 3_000;

type BillingStatusSnapshot = {
  userId: string;
  state: BillingAccessRemoteState;
  checkedAt: number;
};

let billingStatusSnapshot: BillingStatusSnapshot | null = null;
let billingStatusRequest: { userId: string; promise: Promise<BillingAccessRemoteState> } | null = null;

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
  const legacyActive = useMemo(
    () => (isLoaded && isSignedIn ? hasMatrixBillingAccess(has) : false),
    [has, isLoaded, isSignedIn],
  );
  const [remoteState, setRemoteState] = useState<BillingAccessRemoteState | null>(null);
  const [remoteChecked, setRemoteChecked] = useState(false);
  const [retryTick, setRetryTick] = useState(0);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || legacyActive) {
      setRemoteState(null);
      setRemoteChecked(!isLoaded || !isSignedIn || legacyActive);
      return;
    }
    if (!userId) {
      setRemoteState({ active: false, entitlement: null, accessReason: null });
      setRemoteChecked(true);
      return;
    }
    const checkoutReturnRequested = isCheckoutSuccessReturn();
    const cached = checkoutReturnRequested ? null : readCachedBillingStatus(userId);
    if (cached !== null) {
      setRemoteState(cached);
      setRemoteChecked(true);
      return;
    }
    let disposed = false;
    let retryTimeoutId: number | undefined;
    setRemoteChecked(false);
    readRemoteBillingStatus(userId, { skipInactiveCache: checkoutReturnRequested })
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
  if (!isSignedIn) return { active: false, checking: false, entitlement: null, accessReason: null };
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

function readCachedBillingStatus(userId: string): BillingAccessRemoteState | null {
  if (!billingStatusSnapshot || billingStatusSnapshot.userId !== userId) return null;
  if (Date.now() - billingStatusSnapshot.checkedAt > BILLING_STATUS_CACHE_TTL_MS) return null;
  return billingStatusSnapshot.state;
}

function isCheckoutSuccessReturn(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("checkout") === "success";
}

function readRemoteBillingStatus(
  userId: string,
  options: { skipInactiveCache?: boolean } = {},
): Promise<BillingAccessRemoteState> {
  if (billingStatusRequest?.userId === userId) return billingStatusRequest.promise;

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
      if (state.active || !options.skipInactiveCache) {
        billingStatusSnapshot = { userId, state, checkedAt: Date.now() };
      }
      return state;
    })
    .finally(() => {
      window.clearTimeout(timeoutId);
      if (billingStatusRequest?.promise === promise) billingStatusRequest = null;
    });

  billingStatusRequest = { userId, promise };
  return promise;
}
