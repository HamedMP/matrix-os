"use client";

import { CalendarPlusIcon, CheckCircle2Icon, MailIcon, ShieldCheckIcon } from "lucide-react";
import type { IntegrationCapabilitySummary } from "@/hooks/useIntegrationCapabilities";

function labelForCapability(capability: IntegrationCapabilitySummary) {
  if (capability.id === "calendar.create_event") return "Calendar event";
  if (capability.id === "email.read_email") return "Email summaries";
  if (capability.id === "github.read_repository") return "Repository context";
  return capability.capability.replaceAll("_", " ");
}

function iconForCapability(capability: IntegrationCapabilitySummary) {
  if (capability.provider === "calendar") return CalendarPlusIcon;
  if (capability.provider === "email") return MailIcon;
  return ShieldCheckIcon;
}

export function AssistantSetupPanel({
  capabilities,
  error,
  onApprove,
}: {
  capabilities: IntegrationCapabilitySummary[];
  error?: string | null;
  onApprove: (capabilityId: string) => void;
}) {
  if (capabilities.length === 0 && !error) return null;

  return (
    <section className="rounded-md border border-[#17281f]/10 bg-[#f8f5ee]/80 p-4 shadow-[0_16px_45px_rgba(23,40,31,0.08)]">
      <div>
        <h2 className="flex items-center gap-2 text-sm font-semibold text-[#111612]">
          <ShieldCheckIcon className="h-4 w-4 text-[#a6542f]" aria-hidden="true" />
          Assistant integrations
        </h2>
        <p className="mt-1 max-w-xl text-xs leading-5 text-[#17281f]/62">
          Hermes can use approved skills for calendar, email, and work context. Externally visible actions still require approval by default.
        </p>
      </div>

      {error && (
        <p
          role="status"
          className="mt-3 rounded-md border border-[#a6542f]/25 bg-[#fff8f2] px-3 py-2 text-xs font-medium text-[#7a351f]"
        >
          {error}
        </p>
      )}

      {capabilities.length > 0 && (
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          {capabilities.map((capability) => {
            const Icon = iconForCapability(capability);
            const approved = capability.approvedAgents.includes("hermes");
            return (
              <div key={capability.id} className="rounded-md border border-[#17281f]/10 bg-white/60 p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Icon className="h-4 w-4 text-[#17281f]/70" aria-hidden="true" />
                    <p className="text-xs font-semibold text-[#111612]">{labelForCapability(capability)}</p>
                  </div>
                  {approved && <CheckCircle2Icon className="h-4 w-4 text-[#4f7f5c]" aria-hidden="true" />}
                </div>
                <p className="mt-2 text-xs capitalize text-[#17281f]/60">{capability.status.replaceAll("_", " ")}</p>
                {!approved && capability.status !== "connect_required" && (
                  <button
                    type="button"
                    onClick={() => onApprove(capability.id)}
                    className="mt-3 inline-flex min-h-8 items-center rounded-md border border-[#17281f]/12 bg-white/75 px-2.5 text-xs font-medium text-[#17281f] transition hover:border-[#17281f]/28"
                  >
                    Approve Hermes
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
