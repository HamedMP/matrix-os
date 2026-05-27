"use client";

import { ActivityIcon, BotIcon, CheckCircle2Icon, GaugeIcon, Settings2Icon, WorkflowIcon } from "lucide-react";
import { AdminSetupWizard, type AdminSetupSessionSummary } from "./AdminSetupWizard";

export interface AdminControlSurface {
  sections: string[];
  providers: Array<{
    id: string;
    label: string;
    status: string;
    mode: "matrix_system_agent" | "bring_your_own" | "integration";
    nextAction: string | null;
  }>;
  settings: Array<{ id: string; label: string; status: string; updatedAt: string }>;
  automationSummary: { active: number; needsApproval: number; lastActivityAt: string | null };
  integrationSummary: { connected: number; approved: number; needsConnection: number };
  readiness: { overallStatus: string; blocked: number; failed: number; ready: number };
  activity: Array<{ id: string; kind: string; summary: string; createdAt: string }>;
  setupSession: AdminSetupSessionSummary | null;
}

function providerTone(status: string) {
  if (status === "available" || status === "approved" || status === "connected") return "text-[#213829] bg-[#4f7f5c]/10 border-[#4f7f5c]/20";
  if (status === "failed" || status === "revoked" || status === "expired") return "text-[#5f2b1e] bg-[#b4532f]/10 border-[#b4532f]/20";
  return "text-[#17281f]/65 bg-white/55 border-[#17281f]/10";
}

export function AdminControlPanel({
  surface,
  onResumeSetup,
}: {
  surface: AdminControlSurface | null;
  onResumeSetup: (target: string) => void;
}) {
  if (!surface) return null;
  const setupSession = surface.setupSession;
  const settingsLabel = surface.settings.some((setting) => setting.status === "failed")
    ? "attention needed"
    : surface.settings.some((setting) => setting.status === "needs_review")
      ? "review before launch"
      : "saved and reloadable";

  return (
    <section className="rounded-md border border-[#17281f]/10 bg-[#f8f5ee]/80 p-4 shadow-[0_16px_45px_rgba(23,40,31,0.08)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-[#111612]">
            <GaugeIcon className="h-4 w-4 text-[#a6542f]" aria-hidden="true" />
            Matrix control
          </h2>
          <p className="mt-1 max-w-xl text-xs leading-5 text-[#17281f]/62">
            Models, agents, integrations, settings, automations, activity, and readiness stay inspectable from one operational surface.
          </p>
        </div>
        <div className="rounded-full border border-[#17281f]/10 bg-white/60 px-2.5 py-1 text-xs font-medium capitalize text-[#17281f]/70">
          {surface.readiness.overallStatus}
        </div>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        {surface.providers.map((provider) => (
          <div key={provider.id} className={`rounded-md border p-3 ${providerTone(provider.status)}`}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <BotIcon className="h-4 w-4" aria-hidden="true" />
                <p className="text-xs font-semibold">{provider.label}</p>
              </div>
              {(provider.status === "available" || provider.status === "approved" || provider.status === "connected") && <CheckCircle2Icon className="h-4 w-4" aria-hidden="true" />}
            </div>
            <p className="mt-1 text-xs capitalize opacity-75">{provider.mode.replaceAll("_", " ")}</p>
            <p className="mt-1 text-xs capitalize opacity-75">{provider.status.replaceAll("_", " ")}</p>
          </div>
        ))}
      </div>

      <div className="mt-3 grid gap-2 lg:grid-cols-[0.9fr_1.1fr]">
        <AdminSetupWizard
          session={setupSession}
          onResume={setupSession ? () => onResumeSetup(setupSession.target) : undefined}
        />
        <div className="grid gap-2 sm:grid-cols-3">
          <div className="rounded-md border border-[#17281f]/10 bg-white/55 p-3">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-[#111612]">
              <WorkflowIcon className="h-3.5 w-3.5" aria-hidden="true" />
              Automations
            </p>
            <p className="mt-2 text-xl font-semibold text-[#17281f]">{surface.automationSummary.active}</p>
            <p className="text-xs text-[#17281f]/55">{surface.automationSummary.needsApproval} need approval</p>
          </div>
          <div className="rounded-md border border-[#17281f]/10 bg-white/55 p-3">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-[#111612]">
              <Settings2Icon className="h-3.5 w-3.5" aria-hidden="true" />
              Settings
            </p>
            <p className="mt-2 text-xl font-semibold text-[#17281f]">{surface.settings.length}</p>
            <p className="text-xs text-[#17281f]/55">{settingsLabel}</p>
          </div>
          <div className="rounded-md border border-[#17281f]/10 bg-white/55 p-3">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-[#111612]">
              <ActivityIcon className="h-3.5 w-3.5" aria-hidden="true" />
              Activity
            </p>
            <p className="mt-2 text-xl font-semibold text-[#17281f]">{surface.activity.length}</p>
            <p className="text-xs text-[#17281f]/55">{surface.activity[0]?.summary ?? "No recent activity"}</p>
          </div>
        </div>
      </div>
    </section>
  );
}
