"use client";

import { useEffect } from "react";
import {
  CheckCircle2Icon,
  CreditCardIcon,
  ShieldCheckIcon,
  SparklesIcon,
} from "lucide-react";
import { capturePostHogEvent } from "@/lib/posthog-client";

const colors = {
  forest: "#434E3F",
  cream: "#E0E1CA",
  ember: "#D06F25",
  border: "#D6D3C8",
  mutedFg: "#5C5A4F",
} as const;

const plans = [
  {
    name: "Starter",
    monthly: "$14",
    annual: "$140",
    machine: "CPX22",
    specs: "2 vCPU / 4 GB RAM / 80 GB disk",
  },
  {
    name: "Builder",
    monthly: "$19",
    annual: "$190",
    machine: "CPX32",
    specs: "4 vCPU / 8 GB RAM / 160 GB disk",
  },
  {
    name: "Max",
    monthly: "$49",
    annual: "$490",
    machine: "CPX52",
    specs: "12 vCPU / 24 GB RAM / 480 GB disk",
  },
] as const;

function PricingCards() {
  return (
    <div className="grid gap-3">
      {plans.map((plan) => (
        <div
          key={plan.name}
          className="rounded-[14px] p-5"
          style={{
            border: `1px solid ${colors.border}`,
            backgroundColor: plan.name === "Builder" ? "rgba(255,247,236,0.9)" : "rgba(250,250,245,0.72)",
          }}
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-[18px] font-semibold" style={{ color: colors.forest }}>
                {plan.name}
              </h3>
              <p className="mt-1 text-[13px]" style={{ color: colors.mutedFg }}>
                {plan.machine} · {plan.specs}
              </p>
            </div>
            {plan.name === "Builder" && (
              <span
                className="rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em]"
                style={{ backgroundColor: "rgba(208,111,37,0.12)", color: colors.ember }}
              >
                Popular
              </span>
            )}
          </div>
          <div className="mt-4 flex items-end justify-between gap-4">
            <div>
              <span className="text-[34px] font-semibold leading-none" style={{ color: colors.forest }}>
                {plan.monthly}
              </span>
              <span className="ml-1 text-[13px]" style={{ color: colors.mutedFg }}>
                /mo
              </span>
            </div>
            <p className="text-right text-[12px]" style={{ color: colors.mutedFg }}>
              {plan.annual}/yr
            </p>
          </div>
          <div className="mt-4 flex gap-2 text-[13px] leading-[1.6]" style={{ color: colors.mutedFg }}>
            <CheckCircle2Icon className="mt-0.5 size-4 shrink-0" style={{ color: colors.ember }} aria-hidden="true" />
            <span>Includes one hosted Matrix computer. Extra machines and storage are add-ons.</span>
          </div>
        </div>
      ))}
      <a
        href="https://app.matrix-os.com/"
        data-ph-event="marketing_billing_cta_clicked"
        data-ph-location="pricing_cards"
        data-ph-target="choose_plan"
        className="inline-flex h-12 w-full items-center justify-center whitespace-nowrap rounded-full px-5 text-[14px] font-semibold transition-all duration-300 hover:-translate-y-0.5 hover:opacity-95"
        style={{
          backgroundColor: colors.forest,
          color: "#FAFAF5",
          boxShadow: "0 12px 28px rgba(67,78,63,0.28)",
        }}
      >
        Choose a plan
      </a>
    </div>
  );
}

export function LandingBilling() {
  useEffect(() => {
    capturePostHogEvent("marketing_billing_viewed", {
      surface: "www",
      location: "landing_pricing",
      pricing_mode: "stripe_static_plans",
      checkout_redirect_host: "app.matrix-os.com",
    });
  }, []);

  return (
    <section
      id="pricing"
      className="relative flex items-center overflow-hidden py-20 md:py-28"
      style={{ backgroundColor: colors.cream }}
    >
      {/* soft ambient glows */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -left-32 top-1/4 size-[420px] rounded-full blur-3xl"
        style={{
          background:
            "radial-gradient(circle, rgba(208,111,37,0.10), transparent 70%)",
        }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-40 bottom-0 size-[480px] rounded-full blur-3xl"
        style={{
          background:
            "radial-gradient(circle, rgba(67,78,63,0.10), transparent 70%)",
        }}
      />

      <div className="relative mx-auto grid w-full max-w-[1140px] items-center gap-10 px-8 md:grid-cols-[0.9fr_1.1fr] lg:gap-16">
        <div>
          <span
            className="inline-flex items-center gap-2 rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.28em]"
            style={{
              backgroundColor: "rgba(208,111,37,0.10)",
              color: colors.ember,
              border: "1px solid rgba(208,111,37,0.18)",
            }}
          >
            <SparklesIcon className="size-3.5" aria-hidden="true" />
            Hosted plans
          </span>
          <h2
            className="mb-6 mt-7 text-[clamp(2rem,4.4vw,3.4rem)] font-semibold leading-[1.05] tracking-[-0.02em]"
            style={{ color: colors.forest }}
          >
            Build your AI computer.
            <br />
            <span style={{ color: colors.ember }}>Launch</span> when ready.
          </h2>
          <p
            className="mb-7 max-w-[48ch] text-[15px] leading-[1.85]"
            style={{ color: colors.mutedFg }}
          >
            Choose the hosted Matrix computer you want to run. Billing starts
            before provisioning because each plan maps to a real dedicated VPS.
          </p>

          <div className="mb-9 flex flex-col gap-3 sm:flex-row sm:items-center">
            <a
              href="https://app.matrix-os.com/"
              data-ph-event="marketing_billing_cta_clicked"
              data-ph-location="pricing_section"
              data-ph-target="choose_plan"
              className="inline-flex h-12 min-w-[180px] items-center justify-center whitespace-nowrap rounded-full px-7 text-[14px] font-semibold transition-all duration-300 hover:-translate-y-0.5 hover:opacity-95"
              style={{
                backgroundColor: colors.forest,
                color: "#FAFAF5",
                boxShadow: "0 14px 32px rgba(67,78,63,0.24)",
              }}
            >
              Choose a plan
            </a>
            <span className="text-[13px]" style={{ color: colors.mutedFg }}>
              Monthly and annual billing. No hosted runtime trials.
            </span>
          </div>

          <div className="grid gap-3">
            {[
              {
                Icon: CheckCircle2Icon,
                title: "Start before you commit",
                text: "Pick a hosted runtime plan only when you are ready to provision a dedicated Matrix computer.",
              },
              {
                Icon: CreditCardIcon,
                title: "Payment at launch",
                text: "The hosted computer has real VPS cost, so payment details are collected before provisioning.",
              },
              {
                Icon: ShieldCheckIcon,
                title: "Your private AI workspace",
                text: "Provision an isolated Matrix computer for your files, agents, automations, and workspace.",
              },
            ].map((item) => (
              <div
                key={item.title}
                className="group flex gap-3.5 rounded-2xl p-4 transition-all duration-300 hover:-translate-y-0.5"
                style={{
                  backgroundColor: "rgba(250,250,245,0.55)",
                  border: "1px solid rgba(67,78,63,0.10)",
                }}
              >
                <div
                  className="flex size-10 shrink-0 items-center justify-center rounded-xl transition-colors"
                  style={{
                    backgroundColor: "rgba(208,111,37,0.12)",
                    color: colors.ember,
                  }}
                >
                  <item.Icon className="size-[18px]" aria-hidden="true" />
                </div>
                <div>
                  <h3
                    className="text-[14px] font-semibold"
                    style={{ color: colors.forest }}
                  >
                    {item.title}
                  </h3>
                  <p
                    className="mt-1 text-[13px] leading-[1.7]"
                    style={{ color: colors.mutedFg }}
                  >
                    {item.text}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div
          className="overflow-hidden rounded-[24px] p-5 md:p-6"
          style={{
            background:
              "linear-gradient(160deg, rgba(255,255,252,0.92), rgba(250,250,245,0.74))",
            border: "1px solid rgba(67,78,63,0.14)",
            boxShadow:
              "0 1px 0 rgba(255,255,255,0.6) inset, 0 40px 90px rgba(50,53,46,0.16)",
          }}
        >
          <div className="mb-5 flex items-center justify-between gap-3 px-1">
            <div
              className="flex items-center gap-2 text-[12px] font-semibold"
              style={{ color: colors.forest }}
            >
              <SparklesIcon
                className="size-4"
                style={{ color: colors.ember }}
                aria-hidden="true"
              />
              Private Matrix computer
            </div>
            <span
              className="rounded-full px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em]"
              style={{
                backgroundColor: "rgba(67,78,63,0.08)",
                color: colors.forest,
              }}
            >
              Stripe checkout
            </span>
          </div>
          <PricingCards />
        </div>
      </div>
    </section>
  );
}
