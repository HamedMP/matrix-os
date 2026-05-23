"use client";

import { RotateCcwIcon } from "lucide-react";

export interface AdminSetupSessionSummary {
  id: string;
  target: string;
  status: "new" | "resumable";
  title: string;
  updatedAt: string;
}

export function AdminSetupWizard({ session }: { session: AdminSetupSessionSummary | null }) {
  return (
    <div className="rounded-md border border-[#17281f]/10 bg-white/55 p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-[#111612]">Setup wizard</p>
          <p className="mt-1 text-xs leading-5 text-[#17281f]/60">
            {session ? session.title : "Start or resume model, integration, settings, or automation setup from one place."}
          </p>
        </div>
        <button
          type="button"
          className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-[#17281f]/12 bg-[#f8f5ee]/85 px-2.5 text-xs font-medium text-[#17281f]"
        >
          <RotateCcwIcon className="h-3.5 w-3.5" aria-hidden="true" />
          Resume setup
        </button>
      </div>
    </div>
  );
}
