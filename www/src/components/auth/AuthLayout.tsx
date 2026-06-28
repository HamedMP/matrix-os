"use client";

import type { ReactNode } from "react";

interface AuthLayoutProps {
  featureContent: ReactNode;
  formContent: ReactNode;
}

export function AuthLayout({ featureContent, formContent }: AuthLayoutProps) {
  return (
    <main className="relative min-h-screen overflow-hidden bg-[#f7f6f0] text-deep">
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "linear-gradient(115deg, rgba(255,255,255,0.88) 0%, rgba(247,246,240,0.96) 46%, rgba(231,231,216,0.92) 100%)",
        }}
      />
      <div
        className="pointer-events-none absolute inset-y-0 left-0 hidden w-[54vw] border-r border-forest/10 bg-white/20 lg:block"
        aria-hidden="true"
      />
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.045]"
        style={{
          backgroundImage:
            "linear-gradient(color-mix(in srgb, var(--forest) 45%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in srgb, var(--forest) 45%, transparent) 1px, transparent 1px)",
          backgroundSize: "56px 56px",
        }}
      />

      <div className="relative mx-auto grid min-h-screen w-full max-w-6xl items-center gap-8 px-5 py-8 lg:grid-cols-[minmax(0,1fr)_minmax(380px,430px)] lg:gap-20 lg:px-10 xl:px-0">
        <div className="min-w-0 border-b border-forest/10 pb-8 lg:border-b-0 lg:pb-0">
          {featureContent}
        </div>

        <aside className="relative mx-auto w-full max-w-[430px] lg:justify-self-end">
          <div className="mb-4 flex items-center justify-between border-b border-forest/12 pb-3 text-xs font-semibold uppercase tracking-[0.18em] text-forest/55">
            <span>Matrix account</span>
            <span>Secure session</span>
          </div>
          <div className="relative overflow-hidden rounded-lg border border-forest/12 bg-white/88 p-3 shadow-[0_24px_70px_rgba(50,53,46,0.14)] backdrop-blur-xl">
            {formContent}
          </div>
        </aside>
      </div>
    </main>
  );
}
