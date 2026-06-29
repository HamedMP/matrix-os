"use client";

import { useEffect } from "react";
import { CheckCircle2Icon, CreditCardIcon, ShieldCheckIcon } from "lucide-react";
import { capturePostHogEvent } from "@/lib/posthog-client";
import { palette as c, fonts } from "./theme";
import { SectionCard, SectionShell, SectionTitle } from "./primitives";
import { Reveal } from "./Reveal";
import { SIGN_UP_HREF } from "./links";

const plans = [
  {
    name: "Starter",
    monthly: "$14",
    annual: "$140",
    machine: "CPX22",
    specs: "2 vCPU / 4 GB RAM / 80 GB disk",
    popular: false,
  },
  {
    name: "Builder",
    monthly: "$19",
    annual: "$190",
    machine: "CPX32",
    specs: "4 vCPU / 8 GB RAM / 160 GB disk",
    popular: true,
  },
  {
    name: "Max",
    monthly: "$49",
    annual: "$490",
    machine: "CPX52",
    specs: "12 vCPU / 24 GB RAM / 480 GB disk",
    popular: false,
  },
] as const;

const valueProps = [
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
] as const;

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
    <SectionShell id="pricing" className="pt-16 md:pt-28">
      <Reveal>
        <SectionCard>
          <div className="px-7 pt-9 pb-8 md:px-12 md:pt-12 md:pb-10" style={{ borderBottom: `1px solid ${c.border}` }}>
            <SectionTitle
              title="Build your AI computer."
              continuation="Each plan is a real dedicated machine, billed when you provision."
            />
          </div>

          <div className="grid md:grid-cols-[0.95fr_1.05fr]">
            <div className="flex flex-col gap-8 px-7 py-9 md:border-r md:px-12 md:py-12" style={{ borderColor: c.border }}>
              {valueProps.map((item) => (
                <div key={item.title} className="flex items-start gap-4">
                  <span
                    className="grid size-10 shrink-0 place-items-center rounded-lg"
                    style={{ backgroundColor: "rgba(67,78,63,0.07)", color: c.forest }}
                  >
                    <item.Icon className="size-4" aria-hidden="true" />
                  </span>
                  <div>
                    <h3 className="text-[1rem] font-medium" style={{ color: c.deep, fontFamily: fonts.sans }}>
                      {item.title}
                    </h3>
                    <p className="mt-1.5 max-w-[24rem] text-[0.9375rem] leading-[1.6]" style={{ color: c.mutedFg }}>
                      {item.text}
                    </p>
                  </div>
                </div>
              ))}
              <p className="mt-auto text-[0.8125rem]" style={{ color: c.subtle }}>
                Monthly and annual billing through Stripe. No hosted runtime trials.
              </p>
            </div>

            <div className="px-7 py-9 md:px-12 md:py-12">
              <div className="overflow-hidden rounded-xl" style={{ border: `1px solid ${c.border}` }}>
                {plans.map((plan, index) => (
                  <div
                    key={plan.name}
                    className={`flex items-center justify-between gap-4 px-5 py-5 ${index < plans.length - 1 ? "border-b" : ""}`}
                    style={{
                      borderColor: c.border,
                      backgroundColor: plan.popular ? "rgba(67,78,63,0.04)" : undefined,
                    }}
                  >
                    <div>
                      <div className="flex items-center gap-2.5">
                        <h3 className="text-[1.0625rem] font-medium" style={{ color: c.deep, fontFamily: fonts.sans }}>
                          {plan.name}
                        </h3>
                        {plan.popular ? (
                          <span
                            className="rounded-md px-2 py-0.5 text-[0.75rem] font-medium"
                            style={{ backgroundColor: c.forestDeep, color: "#F4F2E6" }}
                          >
                            Popular
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-1 text-[0.8125rem]" style={{ color: c.subtle }}>
                        {plan.machine} · {plan.specs}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-[2rem] leading-none" style={{ fontFamily: fonts.display, color: c.forest }}>
                        {plan.monthly}
                        <span className="ml-1 text-[0.8125rem]" style={{ color: c.subtle, fontFamily: fonts.sans }}>
                          /mo
                        </span>
                      </p>
                      <p className="mt-1 text-[0.8125rem]" style={{ color: c.subtle }}>
                        {plan.annual}/yr
                      </p>
                    </div>
                  </div>
                ))}
              </div>

              <p className="mt-4 flex gap-2.5 text-[0.875rem] leading-[1.6]" style={{ color: c.mutedFg }}>
                <CheckCircle2Icon className="mt-0.5 size-4 shrink-0" style={{ color: c.forest }} aria-hidden="true" />
                <span>Every plan includes one hosted Matrix computer. Extra machines and storage are add-ons.</span>
              </p>

              <a
                href={SIGN_UP_HREF}
                data-ph-event="marketing_billing_cta_clicked"
                data-ph-location="pricing_section"
                data-ph-target="choose_plan"
                className="mt-6 inline-flex w-full items-center justify-center rounded-[0.625rem] px-5 py-3.5 text-[0.9375rem] font-medium leading-none transition-opacity hover:opacity-85"
                style={{ backgroundColor: c.deep, color: "#FAFAF5" }}
              >
                Choose a plan
              </a>
            </div>
          </div>
        </SectionCard>
      </Reveal>
    </SectionShell>
  );
}
