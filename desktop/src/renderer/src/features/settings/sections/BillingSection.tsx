import { CreditCard, ExternalLink } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { z } from "zod/v4";
import { Button } from "../../../design/primitives";
import { invoke } from "../../../lib/operator";
import { useConnection } from "../../../stores/connection";
import { Card, Row, SectionHeader } from "./section-kit";

const BillingEntitlementSchema = z
  .object({
    source: z.enum(["stripe", "override"]),
    planSlug: z.string().min(1).max(64),
    status: z.string().min(1).max(64),
    maxRuntimeSlots: z.number().int().nonnegative(),
    includedRuntimeSlots: z.number().int().nonnegative(),
    addonRuntimeSlots: z.number().int().nonnegative(),
    defaultServerType: z.string().min(1).max(64),
    allowedServerTypes: z.array(z.string().min(1).max(64)).max(16),
    stripeSubscriptionId: z.string().max(256).nullable(),
    stripePriceId: z.string().max(256).nullable(),
    gracePeriodEndsAt: z.string().max(64).nullable(),
    effectiveFrom: z.string().max(64),
    effectiveUntil: z.string().max(64).nullable(),
    updatedAt: z.string().max(64),
  })
  .strict();

const BillingStatusSchema = z
  .object({
    entitlement: BillingEntitlementSchema.nullable(),
    access: z
      .object({
        runtimeProxyAllowed: z.boolean(),
        reason: z.string().max(128).optional(),
      })
      .passthrough(),
  })
  .passthrough();

const BillingRedirectSchema = z
  .object({
    url: z
      .string()
      .url()
      .max(2048)
      .refine((url) => new URL(url).protocol === "https:", "Billing redirects must use HTTPS"),
  })
  .strict();

type BillingEntitlement = z.infer<typeof BillingEntitlementSchema>;
type BillingStatus = z.infer<typeof BillingStatusSchema>;
type BillingInterval = "monthly" | "annual";
type BillingPlan = "matrix_starter" | "matrix_builder" | "matrix_max";
type BillingRegion = "region_fsn1" | "region_nbg1" | "region_ash" | "region_hil";

const PLAN_LABELS: Record<string, string> = {
  matrix_starter: "Starter",
  matrix_builder: "Builder",
  matrix_max: "Max",
  internal: "Internal",
};

const PLANS: Array<{ slug: BillingPlan; label: string }> = [
  { slug: "matrix_starter", label: "Starter" },
  { slug: "matrix_builder", label: "Builder" },
  { slug: "matrix_max", label: "Max" },
];

const REGIONS: Array<{ slug: BillingRegion; label: string }> = [
  { slug: "region_fsn1", label: "EU Falkenstein" },
  { slug: "region_nbg1", label: "EU Nuremberg" },
  { slug: "region_ash", label: "US Ashburn" },
  { slug: "region_hil", label: "US Hillsboro" },
];

function planLabel(slug: string): string {
  return PLAN_LABELS[slug] ?? slug.replace(/^matrix_/, "").replaceAll("_", " ");
}

function formatStatus(status: string): string {
  return status.replaceAll("_", " ");
}

function entitlementSummary(entitlement: BillingEntitlement | null): string {
  if (!entitlement) return "No billing entitlement found.";
  return `${planLabel(entitlement.planSlug)} · ${formatStatus(entitlement.status)}`;
}

function useBillingStatus() {
  const api = useConnection((s) => s.api);
  const [status, setStatus] = useState<BillingStatus | null>(null);
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
      const raw = await api.get<unknown>("/billing/status");
      const parsed = BillingStatusSchema.parse(raw);
      setStatus(parsed);
    } catch (err: unknown) {
      console.warn("[billing] status unavailable:", err instanceof Error ? err.message : String(err));
      setStatus(null);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { status, loading, error, refresh };
}

export default function BillingSection() {
  const api = useConnection((s) => s.api);
  const platformHost = useConnection((s) => s.platformHost);
  const { status, loading, error, refresh } = useBillingStatus();
  const [plan, setPlan] = useState<BillingPlan>("matrix_builder");
  const [interval, setInterval] = useState<BillingInterval>("monthly");
  const [region, setRegion] = useState<BillingRegion>("region_fsn1");
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<"checkout" | "portal" | null>(null);

  const active = status?.access.runtimeProxyAllowed === true;
  const entitlement = status?.entitlement ?? null;
  const portalAvailable = entitlement?.source === "stripe" && Boolean(entitlement.stripeSubscriptionId);
  const settingsUrl = useMemo(() => {
    const base = platformHost.startsWith("https://") ? platformHost : "https://app.matrix-os.com";
    return `${base.replace(/\/$/, "")}/?billing=setup`;
  }, [platformHost]);

  async function openBillingUrl(url: string): Promise<void> {
    await invoke("shell:open-external", { url });
  }

  async function startCheckout(): Promise<void> {
    if (!api || actionLoading) return;
    setActionError(null);
    setActionLoading("checkout");
    try {
      const raw = await api.post<unknown>("/billing/checkout", {
        planSlug: plan,
        interval,
        regionSlug: region,
      });
      const parsed = BillingRedirectSchema.parse(raw);
      await openBillingUrl(parsed.url);
    } catch (err: unknown) {
      console.warn("[billing] checkout unavailable:", err instanceof Error ? err.message : String(err));
      setActionError("Checkout is unavailable. Try again in a moment.");
    } finally {
      setActionLoading(null);
    }
  }

  async function openPortal(): Promise<void> {
    if (!api || !portalAvailable || actionLoading) return;
    setActionError(null);
    setActionLoading("portal");
    try {
      const raw = await api.post<unknown>("/billing/portal", {});
      const parsed = BillingRedirectSchema.parse(raw);
      await openBillingUrl(parsed.url);
    } catch (err: unknown) {
      console.warn("[billing] portal unavailable:", err instanceof Error ? err.message : String(err));
      setActionError("Billing portal is unavailable. Try again in a moment.");
    } finally {
      setActionLoading(null);
    }
  }

  return (
    <>
      <SectionHeader
        title="Billing"
        description="Manage hosted runtime billing through the native Matrix session."
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
              {loading ? "Checking billing..." : active ? "Billing active" : "Billing required"}
            </p>
            <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
              {loading ? "Reading your platform billing status." : entitlementSummary(entitlement)}
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
        {entitlement ? (
          <>
            <Row label="Plan" value={planLabel(entitlement.planSlug)} />
            <Row label="Status" value={formatStatus(entitlement.status)} />
            <Row
              label="Runtime slots"
              value={`${entitlement.includedRuntimeSlots + entitlement.addonRuntimeSlots} of ${entitlement.maxRuntimeSlots}`}
            />
            <Row label="Default machine" value={entitlement.defaultServerType} />
          </>
        ) : null}

        {active ? (
          <div className="flex items-center justify-between border-t pt-3" style={{ borderColor: "var(--border-subtle)" }}>
            <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
              Invoices, payment methods, coupons, and cancellation live in Stripe.
            </p>
            <Button onClick={() => void openPortal()} disabled={!portalAvailable || actionLoading !== null}>
              {actionLoading === "portal" ? "Opening..." : "Open portal"}
              <ExternalLink size={14} />
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3 border-t pt-3" style={{ borderColor: "var(--border-subtle)" }}>
            <div className="grid gap-3 md:grid-cols-3">
              <label className="flex flex-col gap-1 text-xs" style={{ color: "var(--text-secondary)" }}>
                Plan
                <select
                  value={plan}
                  onChange={(event) => setPlan(event.currentTarget.value as BillingPlan)}
                  className="h-9 rounded-md border px-2 text-sm"
                  style={{ background: "var(--bg-sunken)", borderColor: "var(--border-default)", color: "var(--text-primary)" }}
                >
                  {PLANS.map((option) => (
                    <option key={option.slug} value={option.slug}>{option.label}</option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs" style={{ color: "var(--text-secondary)" }}>
                Interval
                <select
                  value={interval}
                  onChange={(event) => setInterval(event.currentTarget.value as BillingInterval)}
                  className="h-9 rounded-md border px-2 text-sm"
                  style={{ background: "var(--bg-sunken)", borderColor: "var(--border-default)", color: "var(--text-primary)" }}
                >
                  <option value="monthly">Monthly</option>
                  <option value="annual">Annual</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs" style={{ color: "var(--text-secondary)" }}>
                Region
                <select
                  value={region}
                  onChange={(event) => setRegion(event.currentTarget.value as BillingRegion)}
                  className="h-9 rounded-md border px-2 text-sm"
                  style={{ background: "var(--bg-sunken)", borderColor: "var(--border-default)", color: "var(--text-primary)" }}
                >
                  {REGIONS.map((option) => (
                    <option key={option.slug} value={option.slug}>{option.label}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
                Checkout opens in your browser and returns to Matrix OS after Stripe confirms payment.
              </p>
              <Button variant="primary" onClick={() => void startCheckout()} disabled={!api || actionLoading !== null}>
                {actionLoading === "checkout" ? "Opening..." : "Continue to checkout"}
                <ExternalLink size={14} />
              </Button>
            </div>
            <Button variant="ghost" onClick={() => void openBillingUrl(settingsUrl)}>
              Open billing setup in browser
            </Button>
          </div>
        )}

        {actionError ? (
          <p className="text-sm" style={{ color: "var(--danger)" }}>
            {actionError}
          </p>
        ) : null}
      </Card>
    </>
  );
}
