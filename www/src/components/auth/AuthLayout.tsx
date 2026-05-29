"use client";

import type { ReactNode } from "react";

interface AuthLayoutProps {
  featureContent: ReactNode;
  formContent: ReactNode;
}

export function AuthLayout({ featureContent, formContent }: AuthLayoutProps) {
  return (
    <main className="relative min-h-screen overflow-hidden bg-page text-deep">
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(circle at 18% 8%, rgba(255,255,250,0.92), transparent 30%), radial-gradient(circle at 80% 18%, color-mix(in srgb, var(--ember) 10%, transparent), transparent 34%), linear-gradient(135deg, color-mix(in srgb, var(--cream) 78%, white) 0%, var(--cream) 52%, var(--page-bg) 100%)",
        }}
      />
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.06]"
        style={{
          backgroundImage:
            "linear-gradient(color-mix(in srgb, var(--forest) 45%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in srgb, var(--forest) 45%, transparent) 1px, transparent 1px)",
          backgroundSize: "48px 48px",
        }}
      />
      <div className="pointer-events-none absolute -left-28 top-8 h-px w-[62vw] bg-forest/15" />
      <div className="pointer-events-none absolute -bottom-40 left-[8vw] h-[520px] w-[720px] rounded-[60%] border border-ember/18" />

      <div className="relative mx-auto grid min-h-screen w-full max-w-6xl items-center gap-8 px-5 py-8 lg:grid-cols-[minmax(0,1fr)_minmax(390px,440px)] lg:gap-16 lg:px-10 xl:px-0">
        <div className="min-w-0 lg:pb-8">
          {featureContent}
        </div>

        <aside className="relative mx-auto w-full max-w-[430px] lg:justify-self-end">
          <div
            className="absolute -inset-6 rounded-[40px] opacity-80 blur-3xl"
            style={{
              background:
                "radial-gradient(circle, color-mix(in srgb, var(--ember) 16%, transparent), transparent 62%)",
            }}
            aria-hidden="true"
          />
          <div className="relative overflow-hidden rounded-[32px] border border-forest/12 bg-white/82 p-3 shadow-[0_30px_80px_rgba(50,53,46,0.17)] backdrop-blur-2xl">
            <div className="mb-2 flex items-center justify-between px-2 py-1">
              <div className="flex items-center gap-1.5" aria-hidden="true">
                <span className="size-3 rounded-full bg-[#ff5f57]" />
                <span className="size-3 rounded-full bg-[#febc2e]" />
                <span className="size-3 rounded-full bg-[#28c840]" />
              </div>
              <span className="rounded-full border border-forest/12 bg-forest/8 px-3 py-1 text-[11px] font-semibold text-forest">
                Secure session
              </span>
            </div>
            <div className="rounded-[24px] border border-forest/8 bg-white/72 p-1 shadow-[0_1px_0_rgba(255,255,255,0.82)_inset]">
              {formContent}
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}
