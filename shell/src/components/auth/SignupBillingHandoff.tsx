"use client";

import { useEffect, useState } from "react";
import { AlertCircleIcon, Loader2Icon } from "lucide-react";
import { palette as c } from "@matrix-os/brand";
import { MatrixBootMark } from "@/components/MatrixBootMark";
import { AuthLayout } from "@/components/auth/AuthLayout";
import { FeatureShowcase } from "@/components/auth/FeatureShowcase";

const HANDOFF_TIMEOUT_MS = 12_000;

function BillingHandoffCard({ timedOut }: { timedOut: boolean }) {
  return (
    <section
      data-matrix-handoff-card="true"
      className="flex min-h-[560px] flex-col items-center justify-center px-4 py-12 text-center"
      aria-live="polite"
    >
      <MatrixBootMark size={56} className="mb-7" />
      {timedOut ? (
        <>
          <AlertCircleIcon className="mb-3 size-5" style={{ color: c.ember }} aria-hidden="true" />
          <h2 className="text-xl font-semibold tracking-tight" style={{ color: c.deep }}>
            Billing settings are still loading
          </h2>
          <p className="mt-3 max-w-xs text-sm leading-6" style={{ color: c.mutedFg }}>
            Matrix could not finish opening billing. Try again after a moment.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-6 inline-flex h-11 items-center justify-center rounded-xl px-5 text-sm font-medium text-white"
            style={{ backgroundColor: c.deep }}
          >
            Try again
          </button>
        </>
      ) : (
        <>
          <Loader2Icon className="mb-4 size-5 animate-spin" style={{ color: c.ember }} aria-hidden="true" />
          <h2 className="text-xl font-semibold tracking-tight" style={{ color: c.deep }}>
            Loading billing status
          </h2>
          <p className="mt-3 max-w-xs text-sm leading-6" style={{ color: c.mutedFg }}>
            Matrix is checking your subscription before opening billing setup.
          </p>
        </>
      )}
    </section>
  );
}

export function SignupBillingHandoff({ startedAt }: { startedAt: number }) {
  const [timedOut, setTimedOut] = useState(() => Date.now() - startedAt >= HANDOFF_TIMEOUT_MS);

  useEffect(() => {
    if (timedOut) return;
    const remainingMs = Math.max(0, HANDOFF_TIMEOUT_MS - (Date.now() - startedAt));
    const timeoutId = window.setTimeout(() => {
      // react-doctor-disable-next-line react-hooks-js/set-state-in-effect -- the retry state is driven by a one-shot elapsed-time boundary and cannot be derived from props alone
      setTimedOut(true);
    }, remainingMs);
    return () => window.clearTimeout(timeoutId);
  }, [startedAt, timedOut]);

  return (
    <div data-matrix-signup-billing-handoff="true">
      <AuthLayout
        featureContent={
          <FeatureShowcase
            variant="product"
            subheading="Create your free account. Your private machine spins up only when you provision it."
          />
        }
        formContent={<BillingHandoffCard timedOut={timedOut} />}
      />
    </div>
  );
}
