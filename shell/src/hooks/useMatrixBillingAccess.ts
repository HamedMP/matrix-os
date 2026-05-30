"use client";

import { useAuth } from "@clerk/nextjs";
import { useEffect, useMemo, useState } from "react";
import { hasMatrixBillingAccess } from "@/lib/billing";

const BILLING_STATUS_TIMEOUT_MS = 10_000;
const BILLING_STATUS_CACHE_TTL_MS = 30_000;

type BillingStatusSnapshot = {
  userId: string;
  active: boolean;
  checkedAt: number;
};

let billingStatusSnapshot: BillingStatusSnapshot | null = null;
let billingStatusRequest: { userId: string; promise: Promise<boolean> } | null = null;

type BillingAccessState = {
  active: boolean | null;
  checking: boolean;
};

export function useMatrixBillingAccess(): BillingAccessState {
  const { isLoaded, isSignedIn, has, userId } = useAuth();
  const legacyActive = useMemo(
    () => (isLoaded && isSignedIn ? hasMatrixBillingAccess(has) : false),
    [has, isLoaded, isSignedIn],
  );
  const [remoteActive, setRemoteActive] = useState<boolean | null>(null);
  const [remoteChecked, setRemoteChecked] = useState(false);
  const [retryTick, setRetryTick] = useState(0);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || legacyActive) {
      setRemoteActive(null);
      setRemoteChecked(!isLoaded || !isSignedIn || legacyActive);
      return;
    }
    if (!userId) {
      setRemoteActive(false);
      setRemoteChecked(true);
      return;
    }
    const cached = readCachedBillingStatus(userId);
    if (cached !== null) {
      setRemoteActive(cached);
      setRemoteChecked(true);
      return;
    }
    let disposed = false;
    let retryTimeoutId: number | undefined;
    setRemoteChecked(false);
    readRemoteBillingStatus(userId)
      .then((active) => {
        if (disposed) return;
        setRemoteActive(active);
        setRemoteChecked(true);
      })
      .catch((error: unknown) => {
        if (disposed) return;
        console.warn("[billing] unable to read Stripe billing status", error);
        setRemoteActive(null);
        setRemoteChecked(false);
        retryTimeoutId = window.setTimeout(() => {
          setRetryTick((current) => current + 1);
        }, 3000);
      });
    return () => {
      disposed = true;
      if (retryTimeoutId !== undefined) window.clearTimeout(retryTimeoutId);
    };
  }, [isLoaded, isSignedIn, legacyActive, retryTick, userId]);

  if (!isLoaded) return { active: null, checking: true };
  if (!isSignedIn) return { active: false, checking: false };
  if (legacyActive) return { active: true, checking: false };
  if (!remoteChecked) return { active: null, checking: true };
  return { active: remoteActive === true, checking: false };
}

export function resetMatrixBillingAccessCacheForTests(): void {
  billingStatusSnapshot = null;
  billingStatusRequest = null;
}

function readCachedBillingStatus(userId: string): boolean | null {
  if (!billingStatusSnapshot || billingStatusSnapshot.userId !== userId) return null;
  if (Date.now() - billingStatusSnapshot.checkedAt > BILLING_STATUS_CACHE_TTL_MS) return null;
  return billingStatusSnapshot.active;
}

function readRemoteBillingStatus(userId: string): Promise<boolean> {
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
      if (!response.ok) return false;
      const body = (await response.json()) as {
        access?: { runtimeProxyAllowed?: boolean };
      };
      return body.access?.runtimeProxyAllowed === true;
    })
    .then((active) => {
      billingStatusSnapshot = { userId, active, checkedAt: Date.now() };
      return active;
    })
    .finally(() => {
      window.clearTimeout(timeoutId);
      if (billingStatusRequest?.promise === promise) billingStatusRequest = null;
    });

  billingStatusRequest = { userId, promise };
  return promise;
}
