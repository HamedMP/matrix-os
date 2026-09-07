"use client";

import { useState, type ReactNode } from "react";
import { ArrowUpRightIcon, ExternalLinkIcon, Loader2Icon, PlusIcon, ReceiptTextIcon, XCircleIcon } from "@/lib/hugeicons";
import { deriveBillingManagementView, type MatrixBillingManagement } from "@matrix-os/contracts";
import type { BillingEntitlementSummary } from "@/hooks/useMatrixBillingAccess";
import { capturePostHogLog } from "@/lib/posthog-client";

const BILLING_CHECKOUT_TIMEOUT_MS = 10_000;
const billingDateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

export function BillingPortalButton({
  entitlement,
  label = "Open billing portal",
  portalAvailable: accountPortalAvailable,
}: {
  entitlement: BillingEntitlementSummary | null;
  label?: string;
  portalAvailable?: boolean;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const portalAvailable = accountPortalAvailable ?? entitlement?.portalAvailable === true;

  async function openPortal() {
    if (!portalAvailable || loading) return;
    setLoading(true);
    setError(null);
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), BILLING_CHECKOUT_TIMEOUT_MS);
    // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler bailout on the try/finally needed to clear the abort timeout and reset `loading` on every path; the code is correct and the finalizer must run whether the request resolves, rejects, or throws.
    try {
      const response = await fetch("/billing/portal", {
        method: "POST",
        credentials: "include",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      const body = response.ok
        ? (await response.json().catch((err: unknown) => {
          capturePostHogLog("warn", "billing portal_response_parse_error", {
            source: "settings-billing",
            error_kind: err instanceof Error ? err.name : typeof err,
          });
          return null;
        })) as { url?: string } | null
        : null;
      if (!response.ok || !body?.url) {
        // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler bailout on the throw inside try/catch; intentional control flow routing an unusable portal response into the catch handler. The code is correct.
        throw new Error("portal_unavailable");
      }
      window.location.assign(body.url);
    } catch (err: unknown) {
      setError("Billing portal is unavailable. Try again in a moment.");
      capturePostHogLog("error", "billing portal_error", {
        source: "settings-billing",
        error_kind: err instanceof Error ? err.message : typeof err,
      });
    } finally {
      window.clearTimeout(timeoutId);
      setLoading(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={openPortal}
        disabled={!portalAvailable || loading}
        className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-forest px-3.5 text-sm font-semibold text-ember-foreground transition-colors hover:bg-forest/90 disabled:cursor-not-allowed disabled:opacity-55"
      >
        {loading ? (
          <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
        ) : (
          <ExternalLinkIcon className="size-4" aria-hidden="true" />
        )}
        {loading ? "Opening portal" : label}
      </button>
      {!portalAvailable && (
        <p className="mt-2 text-xs leading-5 text-forest/55">
          {deriveBillingManagementView(entitlement).portalMessage}
        </p>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  );
}

export function ActiveBillingPanel({
  entitlement,
  management,
  accessReason,
}: {
  entitlement: BillingEntitlementSummary | null;
  management?: MatrixBillingManagement;
  accessReason: string | null;
}) {
  const view = deriveBillingManagementView(entitlement, management, accessReason);
  const trialEndLabel = view.trialEndsAt ? formatDate(view.trialEndsAt) : null;
  const portal = (label: string) => (
    <BillingPortalButton entitlement={entitlement} portalAvailable={view.portalAvailable} label={label} />
  );
  return (
    <div className="space-y-3">
      <section className="rounded-[22px] border border-forest/15 bg-card p-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-forest/55">
              {trialEndLabel ? "Free trial active" : (view.subscription || accessReason === "legacy_clerk_plan") ? "Current plan" : "Runtime access"}
            </p>
            <h3 className="mt-2 text-2xl font-semibold tracking-tight text-deep">{view.planName}</h3>
            <p className="mt-1 text-sm leading-6 text-forest/65">{view.accessDescription}</p>
            {trialEndLabel && (
              <>
                <p className="mt-1 text-sm leading-6 text-forest/65">
                  {view.subscription?.recurringPrice
                    ? `Your ${view.billingLabel} subscription starts on ${trialEndLabel}.`
                    : `Your trial ends on ${trialEndLabel}.`}
                </p>
                <p className="mt-1 text-sm font-medium text-ember">Cancel before {trialEndLabel} to avoid being charged.</p>
              </>
            )}
            {view.paymentRequired && <p role="alert" className="mt-2 text-sm text-ember">Payment required. Update your payment method in the billing portal.</p>}
          </div>
          {view.portalAvailable && portal(trialEndLabel ? "Manage trial" : "Open billing portal")}
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-4">
          <BillingMetric label={view.subscription ? "Subscription status" : "Access status"} value={view.statusLabel} />
          <BillingMetric label="Computer allowance" value={view.allowanceLabel}
            detail={view.computerCount === null ? undefined : `${view.computerCount} computers on this account`} />
          <BillingMetric label="Billing" value={view.billingLabel} />
          <BillingMetric label="Location" value={view.locationLabel} detail={view.countryLabel || undefined} />
        </div>
      </section>
      {!view.portalAvailable && (
        <section className="rounded-2xl border border-forest/12 bg-card p-4 text-sm text-forest/65">
          {view.portalMessage}
        </section>
      )}
      {view.portalAvailable && (
        <section className="grid gap-3 lg:grid-cols-3">
          {view.subscription && (
            <BillingAction icon={<ArrowUpRightIcon className="size-4" aria-hidden="true" />}
              title="Upgrade or downgrade" description="Review available plan changes in the billing portal."
              action={portal("Change plan")} />
          )}
          {view.subscription && (
            <BillingAction icon={<PlusIcon className="size-4" aria-hidden="true" />}
              title="Add-ons" description="Review available subscription options in the billing portal."
              action={portal("Manage add-ons")} />
          )}
          <BillingAction icon={<ReceiptTextIcon className="size-4" aria-hidden="true" />}
            title="Receipts and payment" description="View invoices, receipts, tax details, payment methods, coupons, and billing email in the portal."
            action={portal("View receipts")} />
        </section>
      )}
      {view.subscription && view.portalAvailable && (
        <section className="rounded-[22px] border border-forest/12 bg-card p-4">
          <div className="flex gap-3">
            <XCircleIcon className="mt-0.5 size-4 shrink-0 text-forest/45" aria-hidden="true" />
            <div>
              <h4 className="text-sm font-semibold text-deep">Canceling</h4>
              <p className="mt-1 text-sm leading-6 text-forest/65">
                Manage cancellation in the billing portal. Canceling a subscription does not automatically delete your computers or owner data.
              </p>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

export function TrialPaymentRecoveryPanel({
  entitlement,
}: {
  entitlement: BillingEntitlementSummary;
}) {
  return (
    <section className="rounded-[22px] border border-ember/30 bg-card p-4 sm:p-5" role="alert">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-ember">Trial ended</p>
          <h3 className="mt-2 text-2xl font-semibold tracking-tight text-deep">Payment required</h3>
          <p className="mt-1 text-sm leading-6 text-forest/65">
            Runtime access is paused until the first payment succeeds.
          </p>
          <p className="mt-1 text-xs leading-5 text-forest/55">
            Update your card in Stripe. Matrix restores access automatically after the paid invoice webhook arrives.
          </p>
        </div>
        <BillingPortalButton entitlement={entitlement} label="Update payment method" />
      </div>
    </section>
  );
}

function BillingMetric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="rounded-2xl border border-forest/10 bg-white p-3">
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-forest/45">{label}</p>
      <p className="mt-2 text-lg font-semibold text-deep">{value}</p>
      {detail && <p className="mt-1 text-xs leading-5 text-forest/55">{detail}</p>}
    </div>
  );
}

function BillingAction({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action: ReactNode;
}) {
  return (
    <div className="rounded-[22px] border border-forest/12 bg-white p-4">
      <div className="flex items-center gap-2 text-deep">
        <span className="inline-flex size-8 items-center justify-center rounded-xl bg-[#f4efe3] text-ember">
          {icon}
        </span>
        <h4 className="text-sm font-semibold">{title}</h4>
      </div>
      <p className="mt-3 min-h-16 text-sm leading-6 text-forest/65">{description}</p>
      <div className="mt-3">{action}</div>
    </div>
  );
}

function formatStatus(status: string): string {
  return status
    .split("_")
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return billingDateFormatter.format(date);
}
