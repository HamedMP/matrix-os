import { CreditCard, ExternalLink } from "@renderer/lib/hugeicons";
import {
  MatrixBillingStatusSchema,
  deriveBillingManagementView,
  closestMatrixRegionSlug,
  type MatrixBillingPublicEntitlement,
  type MatrixBillingStatus,
} from "@matrix-os/contracts";
import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { z } from "zod/v4";
import { Button } from "../../../design/primitives";
import { invoke } from "../../../lib/operator";
import { useConnection } from "../../../stores/connection";
import { Card, Row, SettingsSectionHeader } from "./section-kit";

const BillingRedirectSchema = z.strictObject({
  url: z
    .url()
    .max(2048)
    .refine((url) => new URL(url).protocol === "https:", "Billing redirects must use HTTPS"),
});

type BillingEntitlement = MatrixBillingPublicEntitlement;
type BillingInterval = "monthly";
type BillingPlan = "matrix_starter" | "matrix_builder" | "matrix_max";
type BillingRegion = "region_fsn1" | "region_nbg1" | "region_ash" | "region_hil";
type BillingAction = "checkout" | "portal";

interface BillingUiState {
  plan: BillingPlan;
  interval: BillingInterval;
  region: BillingRegion;
  actionError: string | null;
  actionLoading: BillingAction | null;
}

type BillingUiAction =
  | { type: "set-plan"; plan: BillingPlan }
  | { type: "set-region"; region: BillingRegion }
  | { type: "start-action"; action: BillingAction }
  | { type: "finish-action" }
  | { type: "fail-action"; message: string };

const INITIAL_BILLING_UI_STATE: BillingUiState = {
  plan: "matrix_builder",
  interval: "monthly",
  region: "region_fsn1",
  actionError: null,
  actionLoading: null,
};

const PLANS: Array<{ slug: BillingPlan; label: string }> = [
  { slug: "matrix_starter", label: "Starter · $20/month" },
  { slug: "matrix_builder", label: "Builder · $100/month" },
  { slug: "matrix_max", label: "Max · $200/month" },
];

const REGIONS: Array<{ slug: BillingRegion; label: string }> = [
  { slug: "region_fsn1", label: "🇩🇪 Falkenstein, Germany" },
  { slug: "region_nbg1", label: "🇩🇪 Nuremberg, Germany" },
  { slug: "region_ash", label: "🇺🇸 Ashburn, Virginia" },
  { slug: "region_hil", label: "🇺🇸 Hillsboro, Oregon" },
];

function closestBillingRegion(): BillingRegion {
  try {
    return closestMatrixRegionSlug(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch (error: unknown) {
    console.warn("[billing] unable to detect closest server location:", error instanceof Error ? error.name : typeof error);
    return "region_fsn1";
  }
}

function billingUiReducer(state: BillingUiState, action: BillingUiAction): BillingUiState {
  switch (action.type) {
    case "set-plan":
      return { ...state, plan: action.plan };
    case "set-region":
      return { ...state, region: action.region };
    case "start-action":
      return { ...state, actionError: null, actionLoading: action.action };
    case "finish-action":
      return { ...state, actionLoading: null };
    case "fail-action":
      return { ...state, actionError: action.message, actionLoading: null };
  }
}

async function openBillingUrl(url: string): Promise<void> {
  await invoke("shell:open-external", { url });
}

function useBillingStatus() {
  const api = useConnection((s) => s.api);
  const runtimeSlot = useConnection((s) => s.runtimeSlot);
  const [status, setStatus] = useState<MatrixBillingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const refresh = useCallback(async () => {
    if (!api) {
      setStatus(null);
      setLoading(false);
      setError(false);
      return;
    }
    setLoading(true);
    setError(false);
    try {
      const raw = await api.get<unknown>(`/billing/status?details=management&runtimeSlot=${encodeURIComponent(runtimeSlot ?? "primary")}`);
      const parsed = MatrixBillingStatusSchema.parse(raw);
      setStatus(parsed);
    } catch (err: unknown) {
      console.warn("[billing] status unavailable:", err instanceof Error ? err.message : String(err));
      setStatus(null);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [api, runtimeSlot]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { status, loading, error, refresh };
}

export default function BillingSection() {
  const api = useConnection((s) => s.api);
  const platformHost = useConnection((s) => s.platformHost);
  const { status, loading, error, refresh } = useBillingStatus();
  const [ui, dispatchUi] = useReducer(
    billingUiReducer,
    INITIAL_BILLING_UI_STATE,
    (initialState) => ({ ...initialState, region: closestBillingRegion() }),
  );

  const active = status?.access.runtimeProxyAllowed === true;
  const entitlement = status?.entitlement ?? null;
  const view = deriveBillingManagementView(entitlement, status?.management);
  const portalAvailable = view.portalAvailable;
  const settingsUrl = useMemo(() => {
    const base = platformHost.startsWith("https://") ? platformHost : "https://app.matrix-os.com";
    return `${base.replace(/\/$/, "")}/?billing=setup`;
  }, [platformHost]);

  async function startCheckout(): Promise<void> {
    if (!api || loading || error || ui.actionLoading) return;
    dispatchUi({ type: "start-action", action: "checkout" });
    try {
      const raw = await api.post<unknown>("/billing/checkout", {
        planSlug: ui.plan,
        interval: ui.interval,
        regionSlug: ui.region,
      });
      const parsed = BillingRedirectSchema.parse(raw);
      await openBillingUrl(parsed.url);
      dispatchUi({ type: "finish-action" });
    } catch (err: unknown) {
      console.warn("[billing] checkout unavailable:", err instanceof Error ? err.message : String(err));
      dispatchUi({ type: "fail-action", message: "Checkout is unavailable. Try again in a moment." });
    }
  }

  async function openPortal(): Promise<void> {
    if (!api || loading || error || !portalAvailable || ui.actionLoading) return;
    dispatchUi({ type: "start-action", action: "portal" });
    try {
      const raw = await api.post<unknown>("/billing/portal", {});
      const parsed = BillingRedirectSchema.parse(raw);
      await openBillingUrl(parsed.url);
      dispatchUi({ type: "finish-action" });
    } catch (err: unknown) {
      console.warn("[billing] portal unavailable:", err instanceof Error ? err.message : String(err));
      dispatchUi({ type: "fail-action", message: "Billing portal is unavailable. Try again in a moment." });
    }
  }

  return (
    <>
      <SettingsSectionHeader
        title="Billing"
        description="View your plan and manage your subscription, invoices, and payment methods."
      />
      <Card>
        <div className="flex items-center gap-3">
          <div
            className="flex size-10 items-center justify-center rounded-lg"
            style={{ background: "var(--accent-muted)", color: "var(--accent)" }}
          >
            <CreditCard size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
              {loading ? "Checking billing..." : "Billing summary"}
            </p>
            <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
              {loading ? "Reading your platform billing status." : view.accessDescription}
            </p>
          </div>
          <Button onClick={() => void refresh()} disabled={loading}>
            Refresh
          </Button>
        </div>

        {error ? (
          <p className="text-sm" style={{ color: "var(--warning)" }}>
            Billing status unavailable. The desktop app could not verify your plan.
          </p>
        ) : null}

        <Row label="Access" value={loading ? "Checking" : active ? "Runtime allowed" : "Runtime locked"} />
        {!loading && !error && api ? (
          <>
            <Row label="Plan" value={view.planName} />
            <Row label={view.subscription ? "Subscription status" : "Access status"} value={view.statusLabel} />
            <Row label="Computer allowance" value={view.allowanceLabel} />
            {view.computerCount !== null && <Row label="Computers on this account" value={String(view.computerCount)} />}
            <Row label="Billing" value={view.billingLabel} />
            <Row label="Location" value={view.locationLabel} />
            {view.paymentRequired && <p role="alert">Payment required. Update your payment method in the billing portal.</p>}
          </>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3" style={{ borderColor: "var(--border-subtle)" }}>
          <div className="min-w-0 flex-1 basis-64">
            <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
              Billing management
            </p>
            <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
              {loading
                ? "Checking billing management availability."
                : error || !api
                  ? "Refresh your billing status to check whether billing management is available."
                  : view.portalMessage}
            </p>
          </div>
          <Button
            variant="primary"
            onClick={() => void openPortal()}
            disabled={!api || loading || error || !portalAvailable || ui.actionLoading !== null}
          >
            {ui.actionLoading === "portal" ? "Opening..." : "Manage billing"}
            <ExternalLink size={14} />
          </Button>
        </div>

        {!active && !loading && !error ? (
          <div className="flex flex-col gap-3 border-t pt-3" style={{ borderColor: "var(--border-subtle)" }}>
            <div className="grid gap-3">
              <label className="flex flex-col gap-1 text-xs" style={{ color: "var(--text-secondary)" }}>
                Plan
                <select
                  value={ui.plan}
                  onChange={(event) => dispatchUi({ type: "set-plan", plan: event.currentTarget.value as BillingPlan })}
                  className="h-9 rounded-md border px-2 text-sm"
                  style={{ background: "var(--bg-sunken)", borderColor: "var(--border-default)", color: "var(--text-primary)" }}
                >
                  {PLANS.map((option) => (
                    <option key={option.slug} value={option.slug}>{option.label}</option>
                  ))}
                </select>
              </label>
              <details className="rounded-md border px-3 py-2" style={{ borderColor: "var(--border-default)" }}>
                <summary className="cursor-pointer text-xs" style={{ color: "var(--text-secondary)" }}>
                  Server location · {REGIONS.find((region) => region.slug === ui.region)?.label}
                </summary>
                <label className="mt-2 flex flex-col gap-1 text-xs" style={{ color: "var(--text-secondary)" }}>
                  Change server location
                  <select
                    value={ui.region}
                    onChange={(event) => dispatchUi({ type: "set-region", region: event.currentTarget.value as BillingRegion })}
                    className="h-9 rounded-md border px-2 text-sm"
                    style={{ background: "var(--bg-sunken)", borderColor: "var(--border-default)", color: "var(--text-primary)" }}
                  >
                    {REGIONS.map((option) => (
                      <option key={option.slug} value={option.slug}>{option.label}</option>
                    ))}
                  </select>
                </label>
              </details>
            </div>
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
                Checkout opens in your browser and returns to Matrix OS after Stripe confirms payment.
              </p>
              <Button variant="primary" onClick={() => void startCheckout()} disabled={!api || ui.actionLoading !== null}>
                {ui.actionLoading === "checkout" ? "Opening..." : "Continue to checkout"}
                <ExternalLink size={14} />
              </Button>
            </div>
            <Button variant="ghost" onClick={() => void openBillingUrl(settingsUrl)}>
              Open billing setup in browser
            </Button>
          </div>
        ) : null}

        {ui.actionError ? (
          <p role="alert" className="text-sm" style={{ color: "var(--danger)" }}>
            {ui.actionError}
          </p>
        ) : null}
      </Card>
    </>
  );
}
