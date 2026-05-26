"use client";

import type { ReactNode } from "react";
import { MATRIX_ONBOARDING_BRAND_VERSION } from "@/lib/onboarding-brand";

interface BrandFrameProps {
  children: ReactNode;
  mediaAvailable?: boolean;
}

export function BrandFrame({ children, mediaAvailable = true }: BrandFrameProps) {
  return (
    <section
      data-onboarding-brand={MATRIX_ONBOARDING_BRAND_VERSION}
      className="relative min-h-full overflow-hidden bg-[#f4f0e8] text-[#111612]"
    >
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(154,168,137,0.22),transparent_28%),linear-gradient(145deg,rgba(231,224,212,0.96),rgba(244,240,232,0.9)_48%,rgba(23,40,31,0.12))]" />
      <div className="absolute inset-x-0 top-0 h-px bg-[#17281f]/10" />
      <div className="relative mx-auto flex min-h-screen w-full max-w-7xl flex-col px-5 py-5 sm:px-8 lg:px-10">
        <header className="flex items-center justify-between">
          <div className="text-sm font-semibold tracking-[0.28em] text-[#17281f]">
            MATRIX
          </div>
          <div className="rounded-full border border-[#17281f]/15 bg-white/45 px-3 py-1 text-xs text-[#17281f]/70 shadow-sm backdrop-blur">
            Personal cloud computer
          </div>
        </header>

        <div className="grid flex-1 items-center gap-8 py-8 lg:grid-cols-[minmax(0,0.95fr)_minmax(440px,1.05fr)]">
          <div className="max-w-2xl">
            <p className="mb-4 text-xs font-medium uppercase tracking-[0.22em] text-[#d6653b]">
              Guided activation
            </p>
            <h1 className="text-balance text-4xl font-medium leading-[1.05] text-[#111612] sm:text-5xl lg:text-6xl">
              Set up Matrix around the work you want done first.
            </h1>
            <p className="mt-5 max-w-xl text-base leading-7 text-[#17281f]/70">
              Connect only the services that matter, learn what Matrix can do, and reach a clear ready-to-work state.
            </p>
            {!mediaAvailable && (
              <div className="mt-6 rounded-md border border-[#d6653b]/25 bg-[#d6653b]/10 px-4 py-3 text-sm text-[#17281f]">
                Product media is unavailable, so Matrix is showing the setup path directly.
              </div>
            )}
          </div>

          <div className="relative rounded-lg border border-[#17281f]/12 bg-white/58 p-4 shadow-[0_24px_80px_rgba(17,22,18,0.12)] backdrop-blur-xl sm:p-5">
            {children}
          </div>
        </div>
      </div>
    </section>
  );
}

