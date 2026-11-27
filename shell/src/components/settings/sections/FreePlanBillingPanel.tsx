"use client";

import { FREE_PLAN_COPY, MATRIX_PRICING_URL } from "@matrix-os/contracts/free-plan-copy";
import { ArrowUpRightIcon, MoonIcon } from "@/lib/hugeicons";

/**
 * Settings > Billing for a Free plan owner (spec 2691, ENG-520): what the plan
 * includes, the sleep rule, and where paid plans are. A free owner has no
 * subscription, portal, or cancellation, so none of those are shown.
 */
export function FreePlanBillingPanel() {
  return (
    <div className="space-y-3">
      <section className="rounded-[22px] border border-forest/15 bg-[#fbf7ed] p-4">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-forest/55">Current plan</p>
        <h3 className="mt-2 text-2xl font-semibold tracking-tight text-deep">{FREE_PLAN_COPY.planName}</h3>
        <p className="mt-1 text-sm leading-6 text-forest/65">{FREE_PLAN_COPY.summary}</p>
      </section>

      <section className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-[22px] border border-forest/12 bg-white p-4">
          <div className="flex gap-3">
            <MoonIcon className="mt-0.5 size-4 shrink-0 text-forest/45" aria-hidden="true" />
            <div>
              <h4 className="text-sm font-semibold text-deep">Sleep and wake</h4>
              <p className="mt-1 text-sm leading-6 text-forest/65">{FREE_PLAN_COPY.sleep}</p>
            </div>
          </div>
        </div>
        <div className="rounded-[22px] border border-forest/12 bg-white p-4">
          <div className="flex gap-3">
            <ArrowUpRightIcon className="mt-0.5 size-4 shrink-0 text-forest/45" aria-hidden="true" />
            <div>
              <h4 className="text-sm font-semibold text-deep">Paid plans</h4>
              <p className="mt-1 text-sm leading-6 text-forest/65">{FREE_PLAN_COPY.upgrade}</p>
              <a
                href={MATRIX_PRICING_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-forest px-3.5 text-sm font-semibold text-ember-foreground transition-colors hover:bg-forest/90"
              >
                See paid plans
              </a>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
