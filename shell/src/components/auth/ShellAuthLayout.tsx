"use client";

import type { ReactNode } from "react";
import { CheckCircle2Icon, SparklesIcon } from "lucide-react";

interface ShellAuthLayoutProps {
  eyebrow: string;
  title: string;
  body: string;
  children: ReactNode;
}

export function ShellAuthLayout({ eyebrow, title, body, children }: ShellAuthLayoutProps) {
  return (
    <main data-matrix-auth-shell="true" className="relative min-h-screen overflow-hidden bg-[#F7F6F0] text-[#323D2E]">
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "linear-gradient(115deg, rgba(255,255,255,0.88) 0%, rgba(247,246,240,0.96) 48%, rgba(224,225,202,0.86) 100%)",
        }}
      />
      <div className="pointer-events-none absolute inset-y-0 left-0 hidden w-[54vw] border-r border-[#323D2E]/10 bg-white/18 lg:block" />
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.045]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(50,61,46,0.38) 1px, transparent 1px), linear-gradient(90deg, rgba(50,61,46,0.38) 1px, transparent 1px)",
          backgroundSize: "56px 56px",
        }}
      />

      <section className="relative mx-auto grid min-h-screen w-full max-w-6xl items-center gap-10 px-6 py-10 md:px-10 lg:grid-cols-[minmax(0,1fr)_minmax(380px,430px)] lg:gap-20 lg:px-14">
        <div className="space-y-8 border-b border-[#323D2E]/10 pb-8 lg:border-b-0 lg:pb-0">
          <div className="inline-flex items-center gap-2 rounded-full border border-[#D06F25]/20 bg-[#D06F25]/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-[#D06F25]">
            <SparklesIcon className="size-3.5" aria-hidden="true" />
            {eyebrow}
          </div>

          <div className="max-w-2xl space-y-5">
            <h1 className="text-balance text-[clamp(2.5rem,6vw,5.4rem)] font-semibold leading-[0.94] text-[#323D2E]">
              {title}
            </h1>
            <p className="max-w-[54ch] text-[15px] leading-8 text-[#5C5A4F] md:text-base">
              {body}
            </p>
          </div>

          <div className="grid max-w-xl divide-y divide-[#323D2E]/12 border-y border-[#323D2E]/12">
            {[
              "Free account first",
              "Stripe checkout at launch",
              "Private hosted runtime",
            ].map((item) => (
              <div
                key={item}
                className="flex items-center gap-3 py-3 text-sm font-medium leading-5 text-[#323D2E]"
              >
                <CheckCircle2Icon className="size-4 flex-none text-[#D06F25]" aria-hidden="true" />
                <span>{item}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="relative mx-auto w-full max-w-[430px]">
          <div className="mb-4 flex items-center justify-between border-b border-[#323D2E]/12 pb-3 text-xs font-semibold uppercase tracking-[0.18em] text-[#323D2E]/55">
            <span>Matrix account</span>
            <span>Secure session</span>
          </div>
          <div className="relative rounded-lg border border-[#323D2E]/12 bg-[#FAFAF9]/88 p-3 shadow-[0_24px_70px_rgba(50,61,46,0.14)] backdrop-blur-xl">
            {children}
          </div>
        </div>
      </section>
    </main>
  );
}
