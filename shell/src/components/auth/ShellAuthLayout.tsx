"use client";

import type { ReactNode } from "react";
import { CheckCircle2Icon, CpuIcon, SparklesIcon } from "lucide-react";

interface ShellAuthLayoutProps {
  eyebrow: string;
  title: string;
  body: string;
  children: ReactNode;
}

export function ShellAuthLayout({ eyebrow, title, body, children }: ShellAuthLayoutProps) {
  return (
    <main className="relative min-h-screen overflow-hidden bg-[#E0E1CA] text-[#323D2E]">
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(circle at 14% 12%, rgba(250,250,249,0.88), transparent 34%), radial-gradient(circle at 82% 18%, rgba(140,199,190,0.24), transparent 30%), radial-gradient(circle at 70% 92%, rgba(208,111,37,0.14), transparent 34%)",
        }}
      />
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.08]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(50,61,46,0.38) 1px, transparent 1px), linear-gradient(90deg, rgba(50,61,46,0.38) 1px, transparent 1px)",
          backgroundSize: "44px 44px",
        }}
      />

      <section className="relative mx-auto grid min-h-screen w-full max-w-7xl items-center gap-12 px-6 py-10 md:grid-cols-[1.05fr_0.95fr] md:px-10 lg:px-14">
        <div className="space-y-8">
          <div className="inline-flex items-center gap-2 rounded-full border border-[#D06F25]/20 bg-[#D06F25]/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-[#D06F25]">
            <SparklesIcon className="size-3.5" aria-hidden="true" />
            {eyebrow}
          </div>

          <div className="max-w-2xl space-y-5">
            <h1 className="text-balance text-[clamp(2.6rem,6vw,5.7rem)] font-semibold leading-[0.94] tracking-[-0.05em] text-[#323D2E]">
              {title}
            </h1>
            <p className="max-w-[54ch] text-[15px] leading-8 text-[#5C5A4F] md:text-base">
              {body}
            </p>
          </div>

          <div className="grid max-w-2xl gap-3 sm:grid-cols-3">
            {[
              "Free account first",
              "Stripe checkout at launch",
              "Private hosted runtime",
            ].map((item) => (
              <div
                key={item}
                className="rounded-2xl border border-[#323D2E]/10 bg-[#FAFAF9]/55 p-4 shadow-[0_18px_45px_rgba(50,61,46,0.08)] backdrop-blur"
              >
                <CheckCircle2Icon className="mb-3 size-4 text-[#D06F25]" aria-hidden="true" />
                <p className="text-sm font-medium leading-5 text-[#323D2E]">{item}</p>
              </div>
            ))}
          </div>

          <div className="relative hidden max-w-[680px] rounded-[28px] border border-[#323D2E]/12 bg-[#FAFAF9]/58 p-4 shadow-[0_42px_100px_rgba(50,61,46,0.18)] backdrop-blur-xl lg:block">
            <div className="mb-3 flex items-center justify-between px-2">
              <div className="flex items-center gap-1.5">
                <span className="size-3 rounded-full bg-[#ff5f57]" />
                <span className="size-3 rounded-full bg-[#febc2e]" />
                <span className="size-3 rounded-full bg-[#28c840]" />
              </div>
              <div className="flex items-center gap-2 text-xs font-medium text-[#6A8A7A]">
                <CpuIcon className="size-3.5" aria-hidden="true" />
                Matrix shell preview
              </div>
            </div>
            <div className="grid h-56 grid-cols-[72px_1fr] gap-3 overflow-hidden rounded-[20px] bg-[#141614] p-3">
              <div className="flex flex-col gap-2 rounded-2xl bg-white/8 p-2">
                {["bg-[#8CC7BE]", "bg-white/30", "bg-white/20", "bg-white/20"].map((color, index) => (
                  <span key={index} className={`size-10 rounded-xl ${color}`} />
                ))}
              </div>
              <div className="grid grid-rows-[34px_1fr] gap-3">
                <div className="rounded-2xl bg-white/10" />
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-2xl border border-white/10 bg-white/10" />
                  <div className="rounded-2xl border border-[#8CC7BE]/25 bg-[#8CC7BE]/15" />
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="relative mx-auto w-full max-w-[430px]">
          <div className="absolute -inset-5 rounded-[34px] bg-[#8CC7BE]/18 blur-2xl" aria-hidden="true" />
          <div className="relative rounded-[30px] border border-[#323D2E]/12 bg-[#FAFAF9]/72 p-3 shadow-[0_34px_90px_rgba(50,61,46,0.18)] backdrop-blur-xl">
            {children}
          </div>
        </div>
      </section>
    </main>
  );
}
