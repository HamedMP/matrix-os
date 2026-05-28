"use client";

import { PricingTable, useAuth } from "@clerk/nextjs";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { CreditCardIcon, Loader2Icon } from "lucide-react";
import {
  MATRIX_BILLING_PLAN,
  MATRIX_BILLING_RETURN_PATH,
  hasMatrixBillingAccess,
} from "@/lib/billing";

function PricingFallback() {
  return (
    <div className="flex min-h-48 items-center justify-center rounded-lg border border-border/50 bg-muted/20">
      <Loader2Icon className="size-5 animate-spin text-muted-foreground" aria-hidden="true" />
    </div>
  );
}

export function BillingSection() {
  const { isLoaded, has } = useAuth();
  const active = isLoaded ? hasMatrixBillingAccess(has) : null;

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Billing</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage Matrix OS paid beta access through Clerk Billing.
          </p>
        </div>
        <Badge
          variant="outline"
          className={
            active === true
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700"
              : active === false
                ? "border-amber-500/30 bg-amber-500/10 text-amber-700"
                : "border-border/30 bg-muted/30 text-muted-foreground"
          }
        >
          {active === true ? "Active" : active === false ? "Not active" : "Checking"}
        </Badge>
      </div>

      <Card>
        <CardContent className="space-y-4">
          <div className="flex items-start gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              <CreditCardIcon className="size-4" aria-hidden="true" />
            </div>
            <div>
              <p className="text-sm font-medium">Early adopter access</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Required plan:{" "}
                <span className="font-medium text-foreground">{MATRIX_BILLING_PLAN}</span>
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {active === true ? (
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4 text-sm text-emerald-800">
          Your early adopter access is active for this Clerk account.
        </div>
      ) : active === false ? (
        <div className="rounded-xl border border-border/60 bg-card p-4">
          <PricingTable
            for="user"
            newSubscriptionRedirectUrl={MATRIX_BILLING_RETURN_PATH}
            fallback={<PricingFallback />}
          />
        </div>
      ) : (
        <div className="flex min-h-48 items-center justify-center rounded-xl border border-border/60 bg-card p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
            Checking billing status
          </div>
        </div>
      )}
    </div>
  );
}
