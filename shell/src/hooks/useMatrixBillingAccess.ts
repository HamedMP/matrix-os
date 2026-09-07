"use client";

import { useAuth } from "@clerk/nextjs";
import {
  MatrixBillingPublicEntitlementSchema,
  MatrixBillingManagementSchema,
  type MatrixBillingManagement,
  type MatrixBillingPublicEntitlement,
} from "@matrix-os/contracts";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { billingManagementScenario } from "./billing-e2e-management";
import { hasMatrixBillingAccess } from "@/lib/billing";

const BILLING_STATUS_TIMEOUT_MS = 10_000;
const BILLING_STATUS_CACHE_TTL_MS = 30_000;
const BILLING_STATUS_RETRY_MS = 3_000;
const BILLING_STATUS_MAX_AUTO_RETRIES = 1;
const BILLING_STATUS_MAX_SESSION_RETRIES = 4;
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
  management?: MatrixBillingManagement;
  trialOffer: BillingTrialOffer | null;
  accessReason: string | null;
  accessIssue: BillingAccessIssue;
  retry: () => void;
};

export type BillingAccessIssue = "auth" | "status" | null;

export type BillingTrialOffer = {
  eligible: boolean;
  durationDays: number;
};

export type BillingEntitlementSummary = MatrixBillingPublicEntitlement;

type BillingAccessRemoteState = {
  active: boolean | null;
  entitlement: BillingEntitlementSummary | null;
  management?: MatrixBillingManagement;
  trialOffer: BillingTrialOffer | null;
  accessReason: string | null;
  accessIssue: BillingAccessIssue;
};

const BILLING_STATUS_UNAVAILABLE_STATE: BillingAccessRemoteState = {
  active: null,
  entitlement: null,
  trialOffer: null,
  accessReason: "billing_status_unavailable",
  accessIssue: "status",
};

function subscribeToE2eBillingScenario(onStoreChange: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener("popstate", onStoreChange);
  return () => window.removeEventListener("popstate", onStoreChange);
}

function readE2eBillingScenario(): string | null {
  if (!e2eBillingBypass || typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("e2e_billing_state");
}

function getServerE2eBillingScenario(): null {
  return null;
}

export function useMatrixBillingAccess(): BillingAccessState {
  const state = useManagedMatrixBillingAccess();
  const e2eBillingScenario = useSyncExternalStore(
    subscribeToE2eBillingScenario,
    readE2eBillingScenario,
    getServerE2eBillingScenario,
  );
  if (!e2eBillingBypass) return state;
  const managementScenario = billingManagementScenario(e2eBillingScenario);
  if (managementScenario) return {
    ...managementScenario, active: true, checking: false, trialOffer: null,
    accessReason: "e2e_test_bypass", accessIssue: null, retry: state.retry,
  };
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
        allowedPlanSlugs: ["matrix_starter", "matrix_builder"],
        allowedSelections: [
          { planSlug: "matrix_starter", regionSlug: "region_ash" },
          { planSlug: "matrix_builder", regionSlug: "region_ash" },
        ],
        portalAvailable: true,
        billingInterval: "monthly",
        recurringPrice: {
          unitAmountMinor: 2000,
          currency: "usd",
          interval: "monthly",
          intervalCount: 1,
          quantity: 1,
        },
        runtimePlacement: {
          regionSlug: "region_ash",
          label: "Ashburn, Virginia",
          countryLabel: "United States",
          networkZone: "us-east",
        },
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
      retry: state.retry,
    };
  }
  if (e2eBillingScenario === "active") {
    return {
      active: true,
      checking: false,
      entitlement: {
        source: "stripe",
        planSlug: "matrix_builder",
        status: "active",
        maxRuntimeSlots: 1,
        includedRuntimeSlots: 1,
        addonRuntimeSlots: 0,
        allowedPlanSlugs: ["matrix_starter", "matrix_builder"],
        allowedSelections: [
          { planSlug: "matrix_starter", regionSlug: "region_fsn1" },
          { planSlug: "matrix_starter", regionSlug: "region_nbg1" },
          { planSlug: "matrix_starter", regionSlug: "region_ash" },
          { planSlug: "matrix_starter", regionSlug: "region_hil" },
          { planSlug: "matrix_builder", regionSlug: "region_fsn1" },
          { planSlug: "matrix_builder", regionSlug: "region_nbg1" },
          { planSlug: "matrix_builder", regionSlug: "region_ash" },
          { planSlug: "matrix_builder", regionSlug: "region_hil" },
        ],
        portalAvailable: true,
        billingInterval: "monthly",
        recurringPrice: {
          unitAmountMinor: 2000,
          currency: "usd",
          interval: "monthly",
          intervalCount: 1,
          quantity: 1,
        },
        runtimePlacement: {
          regionSlug: "region_ash",
          label: "Ashburn, Virginia",
          countryLabel: "United States",
          networkZone: "us-east",
        },
        gracePeriodEndsAt: null,
        trialStartedAt: null,
        trialEndsAt: null,
        trialConvertedAt: null,
        firstTrialPaymentFailedAt: null,
        effectiveFrom: "2026-08-31T00:00:00.000Z",
        effectiveUntil: null,
        updatedAt: "2026-08-31T00:00:00.000Z",
      },
      trialOffer: null,
      accessReason: "e2e_test_bypass",
      accessIssue: null,
      retry: state.retry,
    };
  }
  if (e2eBillingScenario === "unavailable") {
    return {
      ...BILLING_STATUS_UNAVAILABLE_STATE,
      checking: false,
      retry: () => {
        const nextUrl = new URL(window.location.href);
        nextUrl.searchParams.set("e2e_billing_state", "active");
        window.history.replaceState({}, "", nextUrl);
        window.dispatchEvent(new Event("popstate"));
      },
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
    retry: state.retry,
  };
}

function readBillingRuntimeSlot(): string | null {
  if (typeof window === "undefined") return null;
  const pathSlot = window.location.pathname.match(/\/~runtime\/([^/]+)/)?.[1];
  return pathSlot ?? new URLSearchParams(window.location.search).get("runtime");
}

function useManagedMatrixBillingAccess(): BillingAccessState {
  const runtimeSlot = useSyncExternalStore(subscribeToE2eBillingScenario, readBillingRuntimeSlot, getServerE2eBillingScenario);
  const { isLoaded, isSignedIn, has, userId } = useAuth();
  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- returned hook API / stable identity for effect dep
  const legacyActive = useMemo(
    () => (isLoaded && isSignedIn ? hasMatrixBillingAccess(has) : false),
    [has, isLoaded, isSignedIn],
  );
  const [remoteState, setRemoteState] = useState<BillingAccessRemoteState | null>(null);
  const [remoteChecked, setRemoteChecked] = useState(false);
  const [retryTick, setRetryTick] = useState(0);
  const failedAttemptsRef = useRef(0);
  const previousCacheKeyRef = useRef<string | null>(null);
  const retryBillingStatus = useCallback(() => {
    failedAttemptsRef.current = 0;
    setRemoteState(null);
    setRemoteChecked(false);
    setRetryTick((current) => current + 1);
  }, []);

  // react-doctor-disable-next-line react-doctor/no-cascading-set-state, react-doctor/no-fetch-in-effect -- this Clerk-dependent status hook is the billing cache/retry coordinator: requests are bounded by AbortSignal.timeout, stale results are gated by `disposed`, retry timers are cleared in cleanup, and no shell-wide query dependency exists. The state pairs are mutually-exclusive loading/result transitions, not a synchronous render cascade.
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
    const billingCacheKey = `${isSignedIn ? userId : PLATFORM_SESSION_BILLING_CACHE_KEY}:${runtimeSlot ?? "primary"}`;
    if (previousCacheKeyRef.current !== billingCacheKey) {
      previousCacheKeyRef.current = billingCacheKey;
      failedAttemptsRef.current = 0;
    }
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
      runtimeSlot,
      skipCache: !shouldUseSnapshotCache,
      skipInactiveCache: checkoutReturnRequested,
    })
      .then((state) => {
        if (disposed) return;
        const shouldRetrySession = state.accessIssue === "auth"
          || (checkoutReturnRequested && state.active === false);
        if (shouldRetrySession && failedAttemptsRef.current >= BILLING_STATUS_MAX_SESSION_RETRIES) {
          setRemoteState(BILLING_STATUS_UNAVAILABLE_STATE);
          setRemoteChecked(true);
          return;
        }
        setRemoteState(state);
        setRemoteChecked(true);
        if (shouldRetrySession) {
          failedAttemptsRef.current += 1;
          retryTimeoutId = window.setTimeout(() => {
            setRetryTick((current) => current + 1);
          }, BILLING_STATUS_RETRY_MS);
        } else {
          failedAttemptsRef.current = 0;
        }
      })
      .catch((error: unknown) => {
        if (disposed) return;
        console.warn("[billing] unable to read Stripe billing status", error);
        if (failedAttemptsRef.current >= BILLING_STATUS_MAX_AUTO_RETRIES) {
          setRemoteState(BILLING_STATUS_UNAVAILABLE_STATE);
          setRemoteChecked(true);
          return;
        }
        failedAttemptsRef.current += 1;
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
  }, [isLoaded, isSignedIn, legacyActive, retryTick, userId, runtimeSlot]);

  if (!isLoaded) return { active: null, checking: true, entitlement: null, trialOffer: null, accessReason: null, accessIssue: null, retry: retryBillingStatus };
  if (legacyActive) {
    return {
      active: true,
      checking: false,
      entitlement: null,
      trialOffer: null,
      accessReason: "legacy_clerk_plan",
      accessIssue: null,
      retry: retryBillingStatus,
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
      retry: retryBillingStatus,
    };
  }
  if (remoteState?.accessIssue === "status") {
    return {
      active: null,
      checking: false,
      entitlement: null,
      trialOffer: null,
      accessReason: remoteState.accessReason,
      accessIssue: "status",
      retry: retryBillingStatus,
    };
  }
  if (!remoteChecked) return { active: null, checking: true, entitlement: null, trialOffer: null, accessReason: null, accessIssue: null, retry: retryBillingStatus };
  return {
    active: remoteState?.active === true,
    checking: false,
    entitlement: remoteState?.entitlement ?? null,
    management: remoteState?.management,
    trialOffer: remoteState?.trialOffer ?? null,
    accessReason: remoteState?.accessReason ?? null,
    accessIssue: null,
    retry: retryBillingStatus,
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
  options: { skipCache?: boolean; skipInactiveCache?: boolean; runtimeSlot?: string | null } = {},
): Promise<BillingAccessRemoteState> {
  if (billingStatusRequest?.cacheKey === cacheKey) return billingStatusRequest.promise;

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), BILLING_STATUS_TIMEOUT_MS);
  const slotQuery = options.runtimeSlot ? `&runtimeSlot=${encodeURIComponent(options.runtimeSlot)}` : "";
  const promise = fetch(`/billing/status?details=management${slotQuery}`, {
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
      if (!response.ok) throw new Error("billing_status_unavailable");
      const body = (await response.json()) as {
        access?: { runtimeProxyAllowed?: boolean; reason?: string };
        entitlement?: unknown;
        management?: unknown;
        trialOffer?: { eligible?: unknown; durationDays?: unknown };
      };
      const parsedEntitlement = body.entitlement === null || body.entitlement === undefined
        ? null
        : MatrixBillingPublicEntitlementSchema.safeParse(body.entitlement);
      if (parsedEntitlement && !parsedEntitlement.success) throw new Error("billing_status_invalid");
      return {
        active: body.access?.runtimeProxyAllowed === true,
        entitlement: parsedEntitlement?.data ?? null,
        management: body.management === undefined ? undefined : MatrixBillingManagementSchema.parse(body.management),
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
