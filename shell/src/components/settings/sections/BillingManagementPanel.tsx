"use client";

import { useState, type ReactNode } from "react";
import { ArrowUpRightIcon, ExternalLinkIcon, Loader2Icon, PlusIcon, ReceiptTextIcon, XCircleIcon } from "@/lib/hugeicons";
import { MATRIX_BILLING_SERVER_PROFILES } from "@/lib/billing";
import type { BillingEntitlementSummary } from "@/hooks/useMatrixBillingAccess";
import { capturePostHogLog } from "@/lib/posthog-client";

const BILLING_CHECKOUT_TIMEOUT_MS = 10_000;
const billingDateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

const billingPlanNames: Record<string, string> = {
  matrix_starter: "Starter",
  matrix_builder: "Builder",
  matrix_max: "Max",
  internal: "Internal",
};

function formatRecurringPrice(
  price: NonNullable<BillingEntitlementSummary["recurringPrice"]>,
): string {
  const formatter = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: price.currency.toUpperCase(),
    minimumFractionDigits: 0,
  });
  const fractionDigits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  const totalMinor = price.unitAmountMinor * price.quantity;
  const amount = formatter.format(totalMinor / (10 ** fractionDigits));
  const period = price.intervalCount === 1
    ? price.interval === "monthly" ? "month" : "year"
    : `${price.intervalCount} ${price.interval === "monthly" ? "months" : "years"}`;
  return `${amount}/${period}`;
}

export function BillingPortalButton({
  entitlement,
  label = "Open billing portal",
}: {
  entitlement: BillingEntitlementSummary | null;
  label?: string;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const portalAvailable = entitlement?.portalAvailable === true;

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
          {entitlement?.source === "override"
            ? "This account has no linked billing customer. Contact the Matrix team for billing help."
            : "Billing management is not available for this account yet. Contact the Matrix team if you have paid."}
        </p>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  );
}

export function ActiveBillingPanel({
  entitlement,
  accessReason,
}: {
  entitlement: BillingEntitlementSummary | null;
  accessReason: string | null;
}) {
  const planName = entitlement ? billingPlanNames[entitlement.planSlug] ?? entitlement.planSlug : "Active";
  const status = entitlement?.status ? formatStatus(entitlement.status) : accessReason === "legacy_clerk_plan" ? "Legacy plan" : "Active";
  const allowedProfiles = MATRIX_BILLING_SERVER_PROFILES.filter((profile) =>
    entitlement?.allowedPlanSlugs.includes(profile.planSlug) === true,
  );
  const totalComputers = entitlement?.maxRuntimeSlots ?? 1;
  const includedComputers = entitlement?.includedRuntimeSlots ?? 1;
  const addonComputers = entitlement?.addonRuntimeSlots ?? 0;
  const graceLabel = entitlement?.gracePeriodEndsAt ? formatDate(entitlement.gracePeriodEndsAt) : null;
  const isTrialing = entitlement?.status === "trialing" && Boolean(entitlement.trialEndsAt);
  const trialEndLabel = entitlement?.trialEndsAt ? formatDate(entitlement.trialEndsAt) : null;
  const billingInterval = entitlement?.billingInterval === "annual" ? "annual" : "monthly";
  const recurringPriceLabel = entitlement?.recurringPrice
    ? formatRecurringPrice(entitlement.recurringPrice)
    : null;
  const placement = entitlement?.runtimePlacement ?? null;

  return (
    <div className="space-y-3">
      <section className="rounded-[22px] border border-forest/15 bg-[#fbf7ed] p-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-forest/55">
              {isTrialing ? "Free trial active" : "Current plan"}
            </p>
            <h3 className="mt-2 text-2xl font-semibold tracking-tight text-deep">
              {planName}
            </h3>
            <p className="mt-1 text-sm leading-6 text-forest/65">
              {isTrialing && trialEndLabel
                ? recurringPriceLabel
                  ? `Your ${recurringPriceLabel} subscription starts on ${trialEndLabel}.`
                  : `Your first ${billingInterval} charge is on ${trialEndLabel}.`
                : `${status}. Your Matrix computers stay available while billing is active${graceLabel ? ` and through the grace period ending ${graceLabel}` : ""}.`}
            </p>
            {isTrialing && trialEndLabel && (
              <p className="mt-1 text-sm font-medium text-ember">
                Cancel before {trialEndLabel} to avoid being charged.
              </p>
            )}
          </div>
          <BillingPortalButton entitlement={entitlement} label={isTrialing ? "Manage trial" : undefined} />
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-4">
          <BillingMetric label="Status" value={status} />
          <BillingMetric label="Computers" value={`${totalComputers}`} detail={`${includedComputers} included${addonComputers ? `, ${addonComputers} add-on` : ""}`} />
          <BillingMetric
            label="Billing"
            value={recurringPriceLabel ?? (billingInterval === "annual" ? "Annual" : "Monthly")}
            detail="Managed subscription"
          />
          <BillingMetric
            label="Location"
            value={placement?.label ?? "Hosted region"}
            detail={placement?.countryLabel ?? "Managed location"}
          />
        </div>
      </section>

      <section className="grid gap-3 lg:grid-cols-3">
        <BillingAction
          icon={<ArrowUpRightIcon className="size-4" aria-hidden="true" />}
          title="Upgrade or downgrade"
          description={`Switch between ${allowedProfiles.length ? allowedProfiles.map((profile) => profile.label).join(", ") : "Starter, Builder, and Max"} without deleting data or machines.`}
          action={<BillingPortalButton entitlement={entitlement} label="Change plan" />}
        />
        <BillingAction
          icon={<PlusIcon className="size-4" aria-hidden="true" />}
          title="Add-ons"
          description="Add extra machines first; storage and other hosted capacity can be attached as add-ons as they launch."
          action={<BillingPortalButton entitlement={entitlement} label="Manage add-ons" />}
        />
        <BillingAction
          icon={<ReceiptTextIcon className="size-4" aria-hidden="true" />}
          title="Receipts and payment"
          description="View invoices, receipts, tax details, payment methods, coupons, and billing email in the portal."
          action={<BillingPortalButton entitlement={entitlement} label="View receipts" />}
        />
      </section>

      <section className="rounded-[22px] border border-forest/12 bg-white p-4">
        <div className="flex gap-3">
          <XCircleIcon className="mt-0.5 size-4 shrink-0 text-forest/45" aria-hidden="true" />
          <div>
            <h4 className="text-sm font-semibold text-deep">Canceling</h4>
            <p className="mt-1 text-sm leading-6 text-forest/65">
              Canceling is handled in the billing portal. Your machines and owner data are not deleted automatically; access remains while billing is active and through the configured three-day grace window.
            </p>
          </div>
        </div>
      </section>
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

