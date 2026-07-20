"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { AlertCircleIcon, Loader2Icon } from "lucide-react";
import { cardShadow, fonts, palette as c } from "@matrix-os/brand";
import { platformShellAssetPath } from "@/lib/platform-shell-assets";

const HANDOFF_TIMEOUT_MS = 12_000;

function ProductFeatureShowcase() {
  return (
    <div style={{ fontFamily: fonts.sans }}>
      <div className="mb-5 flex items-center gap-2.5">
        <Image
          src={platformShellAssetPath("/logo-rabbit.png")}
          alt="Matrix OS"
          width={30}
          height={30}
          className="size-[30px] rounded-lg border object-contain p-1"
          style={{ backgroundColor: c.card, borderColor: c.border }}
          unoptimized
        />
        <span className="text-xs font-medium" style={{ color: c.forest }}>
          matrix-os
        </span>
      </div>

      <h1
        className="max-w-[13ch] text-balance text-[clamp(2.1rem,4vw,2.7rem)] leading-[1.02]"
        style={{ color: c.deep, fontFamily: fonts.display, fontWeight: 400 }}
      >
        A computer in the cloud for your AI agents
      </h1>
      <p
        className="mt-3 max-w-[40ch] text-sm leading-[1.55]"
        style={{ color: c.mutedFg }}
      >
        Run Claude, Codex, and Hermes as background agents that keep going after your laptop closes.
      </p>

      <div
        className="mt-[18px] overflow-hidden rounded-xl border"
        style={{ backgroundColor: c.card, borderColor: c.border, boxShadow: "0 20px 50px rgba(50,53,46,0.10)" }}
        aria-label="Matrix agent workspace preview"
      >
        <div
          className="flex items-center gap-[5px] border-b px-2.5 py-[7px]"
          style={{ background: "#F1EFE7", borderColor: c.border }}
        >
          {[0, 1, 2].map((dot) => (
            <span key={dot} className="size-[7px] rounded-full" style={{ background: c.border }} />
          ))}
          <span className="ml-2 font-mono text-[10px]" style={{ color: c.subtle }}>
            workspace
          </span>
        </div>
        <div className="grid grid-cols-2 gap-px" style={{ background: c.border }}>
          <div className="min-h-24 p-3 font-mono text-[10px] leading-[1.7]" style={{ background: c.forestDeep }}>
            <p className="m-0 text-[#9FB39A]">$ claude build tracker</p>
            <p className="m-0" style={{ color: c.cream }}>› writing ~/apps/app.tsx</p>
            <p className="m-0 text-[#C0DD97]">✓ done in 4.2s</p>
          </div>
          <div className="p-3" style={{ background: c.card }}>
            <p className="m-0 text-[10px] font-semibold uppercase tracking-[0.1em]" style={{ color: c.subtle }}>
              Agents
            </p>
            <div className="mt-[7px] flex flex-col gap-1.5 text-[11px]" style={{ color: c.deep }}>
              <span>● Claude · running</span>
              <span>● Codex · PR opened</span>
              <span style={{ color: c.subtle }}>○ Hermes · idle</span>
            </div>
          </div>
        </div>
      </div>
    </div>
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
    <main
      data-matrix-auth-shell="true"
      data-matrix-signup-billing-handoff="true"
      className="relative min-h-screen overflow-hidden"
      style={{ backgroundColor: c.pageBg, color: c.deep }}
    >
      <div className="relative mx-auto grid min-h-screen w-full max-w-6xl items-center gap-8 px-5 py-10 lg:grid-cols-[minmax(0,1fr)_minmax(380px,430px)] lg:gap-20 lg:px-10 xl:px-0">
        <section className="min-w-0 border-b pb-8 lg:border-b-0 lg:pb-0" style={{ borderColor: c.border }}>
          <ProductFeatureShowcase />
        </section>

        <aside className="relative mx-auto w-full max-w-[430px] lg:justify-self-end">
          <div
            className="mb-4 flex items-center justify-between border-b pb-3 text-xs font-semibold uppercase tracking-[0.18em]"
            style={{ borderColor: c.border, color: c.subtle }}
          >
            <span>Matrix account</span>
            <span>Secure session</span>
          </div>
          <section
            className="relative flex min-h-[560px] flex-col items-center justify-center overflow-hidden rounded-2xl border p-8 text-center"
            style={{ backgroundColor: c.card, borderColor: c.border, boxShadow: cardShadow }}
            aria-live="polite"
          >
            <Image
              src={platformShellAssetPath("/logo-rabbit.png")}
              alt=""
              width={64}
              height={64}
              className="mb-6 size-16 object-contain"
              aria-hidden="true"
              unoptimized
            />
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
        </aside>
      </div>
    </main>
  );
}
