"use client";

import { Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { useAuth } from "@clerk/nextjs";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertCircleIcon, Loader2Icon, LogInIcon } from "lucide-react";
import {
  getMatrixBillingSuccessRedirectUrl,
} from "@/lib/billing";
import { useMatrixBillingAccess } from "@/hooks/useMatrixBillingAccess";
import { capturePostHogEvent, capturePostHogLog } from "@/lib/posthog-client";
import { Settings } from "./Settings";

const e2eBillingBypass = process.env.NEXT_PUBLIC_E2E_TEST_BYPASS === "1";
const CHECKOUT_ATTEMPT_STORAGE_KEY = "matrix.billing.checkoutAttemptAt";
const CHECKOUT_ATTEMPT_MAX_AGE_MS = 30 * 60 * 1000;
const DEFAULT_SIGN_IN_URL = "https://matrix-os.com/login";
const DEVICE_SETUP_POLL_MS = 8_000;
const DEVICE_SETUP_MAX_POLLS = 60;
const DEVICE_SETUP_TIMEOUT_MS = 10_000;

function logCheckoutStorageError(action: "read" | "write", error: unknown): void {
  if (error instanceof Error) {
    console.warn(`[billing] unable to ${action} checkout attempt state`, error.message);
    return;
  }

  console.warn(`[billing] unable to ${action} checkout attempt state`);
}

function rememberBillingCheckoutAttempt(): void {
  if (typeof window === "undefined") return;

  try {
    window.sessionStorage.setItem(CHECKOUT_ATTEMPT_STORAGE_KEY, String(Date.now()));
    capturePostHogEvent("billing_checkout_attempt_remembered", {
      surface: "shell",
      source: "billing_gate",
    });
  } catch (error) {
    logCheckoutStorageError("write", error);
  }
}

function hasRecentBillingCheckoutAttempt(): boolean {
  if (typeof window === "undefined") return false;

  try {
    const rawAttemptAt = window.sessionStorage.getItem(CHECKOUT_ATTEMPT_STORAGE_KEY);
    if (!rawAttemptAt) return false;

    const attemptAt = Number(rawAttemptAt);
    return Number.isFinite(attemptAt) && Date.now() - attemptAt <= CHECKOUT_ATTEMPT_MAX_AGE_MS;
  } catch (error) {
    logCheckoutStorageError("read", error);
    return false;
  }
}

function normalizeDeviceReturnPath(value: string | null): string | null {
  if (!value || value.length > 2048 || !value.startsWith("/") || value.startsWith("//")) {
    return null;
  }

  try {
    const url = new URL(value, "https://app.matrix-os.com");
    if (url.pathname !== "/auth/device") return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch (error) {
    console.warn("[billing] invalid device return path", error instanceof Error ? error.name : typeof error);
    return null;
  }
}

function getBillingCheckoutReturnPath(deviceReturnPath: string | null): string | undefined {
  if (!deviceReturnPath || typeof window === "undefined") return undefined;
  const url = new URL(window.location.href);
  url.searchParams.delete("billing");
  url.searchParams.delete("checkout");
  url.searchParams.set("device_return", deviceReturnPath);
  return `${url.pathname}${url.search}`;
}

function BillingRequired({ checkoutReturnPath }: { checkoutReturnPath?: string }) {
  return (
    <Settings
      open
      onOpenChange={() => {}}
      defaultSection="billing"
      lockedSection="billing"
      billingActiveOverride={false}
      closeDisabled
      billingMode={checkoutReturnPath ? "device-setup" : "provisioning"}
      onBillingCheckoutIntent={rememberBillingCheckoutAttempt}
      billingCheckoutReturnPath={checkoutReturnPath}
    />
  );
}

function getSignInRedirectUrl(): string {
  const configuredSignInUrl = process.env.NEXT_PUBLIC_CLERK_SIGN_IN_URL ?? DEFAULT_SIGN_IN_URL;
  const currentUrl =
    typeof window !== "undefined"
      ? `${window.location.pathname}${window.location.search}${window.location.hash}`
      : "/";
  const appOrigin =
    typeof window !== "undefined" && window.location.origin
      ? window.location.origin
      : "https://app.matrix-os.com";
  const signInUrl = new URL(configuredSignInUrl, appOrigin);
  signInUrl.searchParams.set("redirect_url", new URL(currentUrl, appOrigin).toString());
  return signInUrl.toString();
}

function SignInRedirecting() {
  useEffect(() => {
    window.location.assign(getSignInRedirectUrl());
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center bg-page-bg px-4 text-deep">
      <section className="relative flex w-full max-w-md flex-col items-center gap-5 overflow-hidden rounded-3xl border border-forest/15 bg-white p-8 text-center shadow-[0_40px_120px_rgba(50,53,46,0.15)]">
        <div
          className="pointer-events-none absolute -right-20 -top-20 size-60 rounded-full opacity-60 blur-3xl"
          style={{
            background:
              "radial-gradient(circle, color-mix(in srgb, var(--ember) 22%, transparent), transparent 70%)",
          }}
          aria-hidden="true"
        />
        <div className="relative flex size-14 items-center justify-center rounded-2xl border border-forest/15 bg-cream/50 shadow-sm">
          <LogInIcon className="size-6 text-ember" aria-hidden="true" />
        </div>
        <div className="relative space-y-2">
          <h1 className="text-xl font-semibold tracking-tight text-deep">
            Opening Matrix OS sign in
          </h1>
          <p className="text-sm leading-6 text-forest/75">
            Redirecting to matrix-os.com so signup stays in one place.
          </p>
        </div>
      </section>
    </main>
  );
}

function reloadCurrentPage(): void {
  window.location.assign(window.location.href);
}

function SubscriptionConfirmationPending({
  status = "preparing",
  onRefresh = () => window.location.assign(getMatrixBillingSuccessRedirectUrl()),
}: {
  status?: "preparing" | "failed";
  onRefresh?: () => void;
}) {
  const failed = status === "failed";

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-deep/30 px-4 py-8 text-deep backdrop-blur-md">
      <section className="relative flex w-full max-w-md flex-col overflow-hidden rounded-3xl border border-forest/15 bg-page-bg/95 shadow-[0_40px_120px_rgba(50,53,46,0.35)]">
        <div
          className="pointer-events-none absolute -right-20 -top-20 size-60 rounded-full opacity-60 blur-3xl"
          style={{
            background:
              "radial-gradient(circle, color-mix(in srgb, var(--ember) 22%, transparent), transparent 70%)",
          }}
          aria-hidden="true"
        />

        <div className="relative flex flex-col items-center gap-5 p-8 text-center">
          <div className="flex size-14 items-center justify-center rounded-2xl border border-forest/15 bg-white shadow-sm">
            {failed ? (
              <AlertCircleIcon className="size-6 text-ember" aria-hidden="true" />
            ) : (
              <Loader2Icon className="size-6 animate-spin text-ember" aria-hidden="true" />
            )}
          </div>
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-forest/60">
              Matrix OS · Billing
            </p>
            <h1 className="text-2xl font-semibold tracking-tight text-deep">
              {failed ? "Matrix setup needs attention" : "Confirming your subscription"}
            </h1>
            <p className="mx-auto max-w-xs text-sm leading-6 text-forest/75">
              {failed
                ? "Billing is active, but your Matrix computer did not finish starting. Try again to continue CLI login."
                : "Stripe is activating billing for your Matrix computer. This usually takes a few seconds — your shell will open automatically."}
            </p>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            className="inline-flex h-10 items-center rounded-xl border border-forest/15 bg-white px-5 text-sm font-semibold text-forest transition-colors hover:bg-cream/60"
          >
            {failed ? "Try again" : "Refresh status"}
          </button>
        </div>
      </section>
    </div>
  );
}

function BillingStatusLoading() {
  return (
    <main data-matrix-billing-gate="true" className="flex min-h-screen items-center justify-center bg-page-bg text-forest/70">
      <output className="flex items-center gap-2 text-sm">
        <Loader2Icon className="size-4 animate-spin text-ember" aria-hidden="true" />
        Loading billing status
      </output>
    </main>
  );
}

export function BillingGate({
  children,
  platformSessionActive = false,
}: {
  children: ReactNode;
  platformSessionActive?: boolean;
}) {
  if (platformSessionActive) {
    return <>{children}</>;
  }

  // useSearchParams() (read inside BillingGateInner) requires a <Suspense> boundary so the page
  // is not forced into full client-side rendering; the fallback mirrors the gate's own loading
  // state so there is no visible change while search params resolve.
  return (
    <Suspense fallback={<BillingStatusLoading />}>
      <BillingGateInner>{children}</BillingGateInner>
    </Suspense>
  );
}

function BillingGateInner({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const { active: billingActive } = useMatrixBillingAccess();
  const router = useRouter();
  const searchParams = useSearchParams();
  const checkoutReturnRequested = searchParams.get("checkout") === "success";
  const deviceReturnPath = normalizeDeviceReturnPath(searchParams.get("device_return"));
  const billingCheckoutReturnPath = getBillingCheckoutReturnPath(deviceReturnPath);
  const hasBillingAccess = isSignedIn ? billingActive === true : false;
  const billingChecking = isSignedIn && billingActive === null;
  const [checkoutJustCompleted, setCheckoutJustCompleted] = useState(false);
  const [checkoutAttemptChecked, setCheckoutAttemptChecked] = useState(false);
  const [deviceSetupStatus, setDeviceSetupStatus] = useState<"idle" | "preparing" | "failed">("idle");
  const lastTrackedState = useRef<string | null>(null);
  const deviceSetupStarted = useRef(false);

  // react-doctor-disable-next-line react-doctor/no-cascading-set-state -- not a cascade: this is a single post-hydration resolution of the checkout-return state. The two setStates batch in one render pass and only re-run when `checkoutReturnRequested` changes; they cannot be derived in render because hasRecentBillingCheckoutAttempt() reads sessionStorage, which is client-only and would break SSR/hydration.
  useEffect(() => {
    if (!checkoutReturnRequested) {
      // react-doctor-disable-next-line react-hooks-js/set-state-in-effect -- client-only resolution of checkout-return state: hasRecentBillingCheckoutAttempt() reads sessionStorage and must run after hydration, so it cannot be a render-time initializer.
      setCheckoutJustCompleted(false);
      setCheckoutAttemptChecked(true);
      return;
    }

    setCheckoutJustCompleted(hasRecentBillingCheckoutAttempt());
    setCheckoutAttemptChecked(true);
  }, [checkoutReturnRequested]);

  useEffect(() => {
    if (hasBillingAccess && checkoutReturnRequested && !deviceReturnPath) {
      capturePostHogEvent("billing_checkout_confirmed", {
        surface: "shell",
        source: "billing_gate",
      });
      // react-doctor-disable-next-line react-doctor/nextjs-no-client-side-redirect -- legit post-action client redirect: once billing access is confirmed for a returning Stripe checkout, this strips the `?checkout=success` query so a reload does not re-trigger the confirmation flow. It must run client-side after the async billing-access check resolves (a server redirect() cannot observe client billing state), and it is gated on hasBillingAccess && checkoutReturnRequested so it fires once, not on every render.
      router.replace("/");
    }
  }, [checkoutReturnRequested, deviceReturnPath, hasBillingAccess, router]);

  useEffect(() => {
    if (!deviceReturnPath || !hasBillingAccess || !isLoaded || !isSignedIn) return;
    if (deviceSetupStarted.current) return;
    const activeDeviceReturnPath = deviceReturnPath;
    deviceSetupStarted.current = true;
    let disposed = false;
    let pollCount = 0;
    let pollTimeout: number | undefined;

    async function fetchWithTimeout(url: string, options: RequestInit): Promise<Response> {
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), DEVICE_SETUP_TIMEOUT_MS);
      return fetch(url, { ...options, signal: controller.signal }).finally(() => {
        window.clearTimeout(timeoutId);
      });
    }

    async function authHeaders(): Promise<HeadersInit> {
      const token = await getToken();
      return {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "Content-Type": "application/json",
        Accept: "application/json",
      };
    }

    async function pollRuntimeReady(): Promise<void> {
      if (disposed) return;
      pollCount += 1;
      if (pollCount > DEVICE_SETUP_MAX_POLLS) {
        setDeviceSetupStatus("failed");
        return;
      }

      const sessionResponse = await fetchWithTimeout("/api/auth/app-session", {
        method: "POST",
        credentials: "include",
        headers: await authHeaders(),
        body: JSON.stringify({ redirectTo: activeDeviceReturnPath }),
      });
      if (disposed) return;

      if (!sessionResponse.ok) {
        pollTimeout = window.setTimeout(() => {
          void pollRuntimeReady().catch((error: unknown) => {
            console.warn("[billing] device runtime poll failed", error instanceof Error ? error.name : typeof error);
            if (!disposed) setDeviceSetupStatus("failed");
          });
        }, DEVICE_SETUP_POLL_MS);
        return;
      }

      const readyResponse = await fetchWithTimeout("/", {
        method: "GET",
        credentials: "include",
        cache: "no-store",
        headers: { Accept: "text/html" },
      });
      if (disposed) return;

      if (readyResponse.ok) {
        window.location.replace(activeDeviceReturnPath);
        return;
      }

      pollTimeout = window.setTimeout(() => {
        void pollRuntimeReady().catch((error: unknown) => {
          console.warn("[billing] device runtime readiness failed", error instanceof Error ? error.name : typeof error);
          if (!disposed) setDeviceSetupStatus("failed");
        });
      }, DEVICE_SETUP_POLL_MS);
    }

    async function startDeviceRuntimeSetup(): Promise<void> {
      setDeviceSetupStatus("preparing");
      const provisionResponse = await fetchWithTimeout("/api/auth/provision-runtime", {
        method: "POST",
        credentials: "include",
        headers: await authHeaders(),
        body: JSON.stringify({}),
      });
      if (disposed) return;
      if (!provisionResponse.ok && provisionResponse.status !== 409) {
        if (provisionResponse.status === 402) {
          deviceSetupStarted.current = false;
          setDeviceSetupStatus("failed");
          return;
        }
        setDeviceSetupStatus("failed");
        return;
      }
      await pollRuntimeReady();
    }

    void startDeviceRuntimeSetup().catch((error: unknown) => {
      console.warn("[billing] device runtime setup failed", error instanceof Error ? error.name : typeof error);
      if (!disposed) setDeviceSetupStatus("failed");
    });

    return () => {
      disposed = true;
      deviceSetupStarted.current = false;
      if (pollTimeout !== undefined) window.clearTimeout(pollTimeout);
    };
  }, [deviceReturnPath, getToken, hasBillingAccess, isLoaded, isSignedIn]);

  useEffect(() => {
    if (!isLoaded) return;
    const state = !isSignedIn
      ? "signed_out"
      : hasBillingAccess
        ? "billing_active"
        : checkoutReturnRequested
          ? "checkout_return_pending"
          : "billing_required";
    if (lastTrackedState.current === state) return;
    lastTrackedState.current = state;
    capturePostHogEvent("shell_access_state_changed", {
      surface: "shell",
      source: "billing_gate",
      access_state: state,
      checkout_return_requested: checkoutReturnRequested,
    });
    capturePostHogLog("info", `shell access ${state}`, {
      surface: "shell",
      source: "billing_gate",
      access_state: state,
      checkout_return_requested: checkoutReturnRequested,
    });
  }, [checkoutReturnRequested, hasBillingAccess, isLoaded, isSignedIn]);

  if (e2eBillingBypass) {
    return <>{children}</>;
  }

  if (!isLoaded || billingChecking) {
    return <BillingStatusLoading />;
  }

  if (!isSignedIn) {
    return <SignInRedirecting />;
  }

  if (!hasBillingAccess && checkoutReturnRequested && !checkoutAttemptChecked) {
    return (
      <main data-matrix-billing-gate="true" className="flex min-h-screen items-center justify-center bg-page-bg text-forest/70">
        <output className="flex items-center gap-2 text-sm">
          <Loader2Icon className="size-4 animate-spin text-ember" aria-hidden="true" />
          Checking billing status...
        </output>
      </main>
    );
  }

  if (!hasBillingAccess) {
    if (checkoutJustCompleted) {
      return (
        <>
          <div className="min-h-screen pointer-events-none select-none blur-[1px] brightness-90">
            {children}
          </div>
          <SubscriptionConfirmationPending />
        </>
      );
    }

    return (
      <>
        <div className="min-h-screen pointer-events-none select-none blur-[1px] brightness-90">
          {children}
        </div>
        <BillingRequired checkoutReturnPath={billingCheckoutReturnPath} />
      </>
    );
  }

  if (deviceReturnPath) {
    return (
      <>
        <div className="min-h-screen pointer-events-none select-none blur-[1px] brightness-90">
          {children}
        </div>
        <SubscriptionConfirmationPending
          status={deviceSetupStatus === "failed" ? "failed" : "preparing"}
          onRefresh={reloadCurrentPage}
        />
      </>
    );
  }

  return <>{children}</>;
}
