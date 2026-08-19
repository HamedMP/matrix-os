"use client";

import { useEffect, useState } from "react";
import { Clock3Icon, ExternalLinkIcon, Loader2Icon } from "lucide-react";
import { useMatrixBillingAccess } from "@/hooks/useMatrixBillingAccess";
import { MATRIX_BILLING_SERVER_PROFILES } from "@/lib/billing";
import { ShellNotificationCard } from "./ShellNotificationCard";

const DAY_MS = 24 * 60 * 60 * 1000;
const CLOCK_REFRESH_MS = 60 * 60 * 1000;
const PORTAL_TIMEOUT_MS = 10_000;
const dateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

export function BillingTrialNotification({
  onPortalNavigate,
}: {
  onPortalNavigate?: (url: string) => void;
} = {}) {
  const { active, entitlement } = useMatrixBillingAccess();
  const [now, setNow] = useState(() => Date.now());
  const [portalLoading, setPortalLoading] = useState(false);
  const [portalError, setPortalError] = useState(false);

  useEffect(() => {
    const intervalId = window.setInterval(() => setNow(Date.now()), CLOCK_REFRESH_MS);
    return () => window.clearInterval(intervalId);
  }, []);

  if (active !== true || entitlement?.status !== "trialing" || !entitlement.trialEndsAt) {
    return null;
  }

  const trialEndsAt = new Date(entitlement.trialEndsAt);
  if (Number.isNaN(trialEndsAt.getTime())) return null;

  const daysRemaining = Math.max(0, Math.ceil((trialEndsAt.getTime() - now) / DAY_MS));
  const urgent = daysRemaining <= 3;
  const profile = MATRIX_BILLING_SERVER_PROFILES.find(
    (candidate) => candidate.planSlug === entitlement.planSlug,
  );
  const interval = entitlement.billingInterval === "annual" ? "annual" : "monthly";
  const price = interval === "annual" ? profile?.annualPriceUsd : profile?.monthlyPriceUsd;

  async function openPortal() {
    setPortalLoading(true);
    setPortalError(false);
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), PORTAL_TIMEOUT_MS);
    try {
      const response = await fetch("/billing/portal", {
        method: "POST",
        credentials: "include",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      const body = (await response.json().catch(() => null)) as { url?: unknown } | null;
      if (!response.ok || typeof body?.url !== "string" || !URL.canParse(body.url)) {
        throw new Error("portal_unavailable");
      }
      const portalUrl = new URL(body.url);
      if (portalUrl.protocol !== "https:") throw new Error("portal_unavailable");
      (onPortalNavigate ?? ((url: string) => window.location.assign(url)))(portalUrl.href);
    } catch (error: unknown) {
      console.warn("[billing] unable to open trial portal", error);
      setPortalError(true);
    } finally {
      window.clearTimeout(timeoutId);
      setPortalLoading(false);
    }
  }

  return (
    <ShellNotificationCard
      aria-label="Matrix free trial"
      className={`rounded-2xl border px-3.5 py-3 backdrop-blur-md backdrop-saturate-150 ${
        urgent
          ? "border-ember/55 bg-card/95 shadow-xl"
          : "border-forest/20 bg-card/95 shadow-lg"
      }`}
      data-urgent={urgent ? "true" : "false"}
      role="status"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className={`mt-0.5 grid size-8 shrink-0 place-items-center rounded-full ${urgent ? "bg-ember/15 text-ember" : "bg-forest/10 text-forest"}`}>
            <Clock3Icon className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-deep">
              {daysRemaining === 1 ? "1 day left in your free trial" : `${daysRemaining} days left in your free trial`}
            </p>
            <p className="mt-0.5 text-sm leading-5 text-forest/65">
              {price ? `$${price}/${interval === "annual" ? "year" : "month"} starts ` : "Your paid plan starts "}
              {dateFormatter.format(trialEndsAt)}.
            </p>
            <p className="text-xs leading-5 text-forest/55">
              Cancel before this date to avoid being charged.
            </p>
            {portalError && (
              <p className="mt-1 text-xs text-red-600">Billing portal is unavailable. Try again.</p>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={openPortal}
          disabled={portalLoading}
          className="inline-flex min-h-9 shrink-0 items-center justify-center gap-1.5 rounded-full bg-forest px-3 text-sm font-semibold text-ember-foreground transition-colors hover:bg-forest/90 disabled:cursor-wait disabled:opacity-70"
        >
          {portalLoading ? (
            <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
          )}
          {portalLoading ? "Opening" : "Manage trial"}
        </button>
      </div>
    </ShellNotificationCard>
  );
}
