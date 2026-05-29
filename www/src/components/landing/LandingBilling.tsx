"use client";

import { PricingTable } from "@clerk/nextjs";
import type { ErrorInfo, ReactNode } from "react";
import { Component, useEffect } from "react";
import {
  CheckCircle2Icon,
  CreditCardIcon,
  Loader2Icon,
  ShieldCheckIcon,
  SparklesIcon,
} from "lucide-react";
import { capturePostHogEvent } from "@/lib/posthog-client";

const checkoutRedirectUrl = "https://app.matrix-os.com/?checkout=success";

const colors = {
  forest: "#434E3F",
  cream: "#E0E1CA",
  ember: "#D06F25",
  border: "#D6D3C8",
  mutedFg: "#5C5A4F",
} as const;

const shouldRenderClerkPricing =
  process.env.NODE_ENV === "production";

class PricingTableBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("[landing-billing] Clerk pricing table failed to render", {
      message: error.message,
      componentStack: errorInfo.componentStack,
    });
    capturePostHogEvent("marketing_billing_pricing_error", {
      surface: "www",
      location: "landing_pricing",
      provider: "clerk",
    });
  }

  render() {
    if (this.state.hasError) {
      return <PricingUnavailableCard />;
    }

    return this.props.children;
  }
}

function PricingFallback() {
  return (
    <div
      className="flex min-h-64 items-center justify-center rounded-[14px]"
      style={{
        border: `1px solid ${colors.border}`,
        backgroundColor: "rgba(250,250,245,0.62)",
      }}
    >
      <div
        className="flex items-center gap-2 text-[13px]"
        style={{ color: colors.mutedFg }}
      >
        <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
        Preparing launch options
      </div>
    </div>
  );
}

function PricingUnavailableCard() {
  return (
    <div
      className="rounded-[14px] p-6"
      style={{
        border: `1px solid ${colors.border}`,
        backgroundColor: "rgba(250,250,245,0.72)",
      }}
    >
      <div className="mb-5 flex items-center gap-3">
        <div
          className="flex size-10 items-center justify-center rounded-full"
          style={{
            backgroundColor: "rgba(208,111,37,0.12)",
            color: colors.ember,
          }}
        >
          <CreditCardIcon className="size-5" aria-hidden="true" />
        </div>
        <div>
          <h3
            className="text-[18px] font-semibold"
            style={{ color: colors.forest }}
          >
            Launch your Matrix computer
          </h3>
          <p className="text-[13px]" style={{ color: colors.mutedFg }}>
            Start free. Add payment details when you launch.
          </p>
        </div>
      </div>

      <div className="mb-6 flex items-baseline gap-2">
        <span
          className="text-[42px] font-semibold leading-none"
          style={{ color: colors.forest }}
        >
          Free
        </span>
        <span className="text-[13px]" style={{ color: colors.mutedFg }}>
          to start exploring
        </span>
      </div>

      <div className="mb-6 grid gap-3">
        {[
          "Create your account without choosing a paid plan.",
          "Explore agents, docs, onboarding, and the product direction first.",
          "Add payment details when you launch the hosted private VPS.",
        ].map((item) => (
          <div
            key={item}
            className="flex gap-2 text-[13px] leading-[1.6]"
            style={{ color: colors.mutedFg }}
          >
            <CheckCircle2Icon
              className="mt-0.5 size-4 shrink-0"
              style={{ color: colors.ember }}
              aria-hidden="true"
            />
            <span>{item}</span>
          </div>
        ))}
      </div>

      <a
        href="/signup"
        data-ph-event="marketing_billing_cta_clicked"
        data-ph-location="pricing_fallback"
        data-ph-target="start_free"
        className="inline-flex h-12 w-full items-center justify-center whitespace-nowrap rounded-full px-5 text-[14px] font-semibold transition-all duration-300 hover:-translate-y-0.5 hover:opacity-95"
        style={{
          backgroundColor: colors.forest,
          color: "#FAFAF5",
          boxShadow: "0 12px 28px rgba(67,78,63,0.28)",
        }}
      >
        Start free
      </a>
    </div>
  );
}

export function LandingBilling() {
  useEffect(() => {
    capturePostHogEvent("marketing_billing_viewed", {
      surface: "www",
      location: "landing_pricing",
      pricing_mode: shouldRenderClerkPricing ? "clerk_pricing_table" : "local_fallback",
      checkout_redirect_host: "app.matrix-os.com",
    });
  }, []);

  return (
    <section
      id="pricing"
      className="relative flex min-h-screen items-center overflow-hidden py-24 md:py-32"
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

      <div className="relative mx-auto grid w-full max-w-[1140px] items-center gap-14 px-8 md:grid-cols-[0.9fr_1.1fr] lg:gap-20">
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
            Start free
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
            Start with a free Matrix OS account and see what it can do. Explore
            the product, learn the workflow, then launch a private hosted Matrix
            computer only when you actually want one.
          </p>

          <div className="mb-9 flex flex-col gap-3 sm:flex-row sm:items-center">
            <a
              href="/signup"
              data-ph-event="marketing_billing_cta_clicked"
              data-ph-location="pricing_section"
              data-ph-target="start_free"
              className="inline-flex h-12 min-w-[180px] items-center justify-center whitespace-nowrap rounded-full px-7 text-[14px] font-semibold transition-all duration-300 hover:-translate-y-0.5 hover:opacity-95"
              style={{
                backgroundColor: colors.forest,
                color: "#FAFAF5",
                boxShadow: "0 14px 32px rgba(67,78,63,0.24)",
              }}
            >
              Start free
            </a>
            <span className="text-[13px]" style={{ color: colors.mutedFg }}>
              Payment details are collected at launch.
            </span>
          </div>

          <div className="grid gap-3">
            {[
              {
                Icon: CheckCircle2Icon,
                title: "Start before you commit",
                text: "Create an account, explore the product, and learn the workflow before a card is involved.",
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
              Pay at launch
            </span>
          </div>
          {shouldRenderClerkPricing ? (
            <PricingTableBoundary>
              <PricingTable
                for="user"
                newSubscriptionRedirectUrl={checkoutRedirectUrl}
                fallback={<PricingFallback />}
              />
            </PricingTableBoundary>
          ) : (
            <PricingUnavailableCard />
          )}
        </div>
      </div>
    </section>
  );
}
