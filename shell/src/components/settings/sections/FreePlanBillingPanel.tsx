"use client";

import type { ReactNode } from "react";
import { FREE_PLAN_COPY } from "@matrix-os/contracts/free-plan-copy";
import { MoonIcon, ReceiptTextIcon } from "@/lib/hugeicons";

/**
 * Settings > Billing for a Free plan owner (spec 2691, ENG-520): what the plan
 * includes and the sleep rule. A free owner has no subscription, portal, or
 * cancellation, and self-serve upgrade does not exist yet, so no plan action
 * is shown.
 */
export function FreePlanBillingPanel({ receipts = null }: {
  /** The receipts link for a former paid owner whose billing customer remains; null hides the section. */
  receipts?: ReactNode;
}) {
  return (
    <div className="space-y-3">
      <section className="rounded-[22px] border border-forest/15 bg-cream/40 p-4">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-forest/55">Current plan</p>
        <h3 className="mt-2 text-2xl font-semibold tracking-tight text-deep">{FREE_PLAN_COPY.planName}</h3>
        <p className="mt-1 text-sm leading-6 text-forest/65">{FREE_PLAN_COPY.summary}</p>
        <p className="mt-1 text-sm leading-6 text-forest/65">{FREE_PLAN_COPY.morePlans}</p>
      </section>

      <section className="rounded-[22px] border border-forest/12 bg-white p-4">
        <div className="flex gap-3">
          <MoonIcon className="mt-0.5 size-4 shrink-0 text-forest/45" aria-hidden="true" />
          <div>
            <h4 className="text-sm font-semibold text-deep">Sleep and wake</h4>
            <p className="mt-1 text-sm leading-6 text-forest/65">{FREE_PLAN_COPY.sleep}</p>
          </div>
        </div>
      </section>

      {receipts ? (
        <section className="rounded-[22px] border border-forest/12 bg-white p-4">
          <div className="flex gap-3">
            <ReceiptTextIcon className="mt-0.5 size-4 shrink-0 text-forest/45" aria-hidden="true" />
            <div>
              <h4 className="text-sm font-semibold text-deep">Receipts and payment history</h4>
              <p className="mt-1 mb-3 text-sm leading-6 text-forest/65">
                Invoices and payment details from your earlier subscription stay in the billing portal.
              </p>
              {receipts}
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}
