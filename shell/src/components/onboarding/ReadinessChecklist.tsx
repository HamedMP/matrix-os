"use client";

import { AlertTriangle, Check, Clock3, CircleDashed } from "lucide-react";
import type { ReadinessGateSummary } from "@/hooks/useOnboarding";

function statusIcon(status: ReadinessGateSummary["status"]) {
  if (status === "pass") return <Check className="h-3.5 w-3.5" aria-hidden="true" />;
  if (status === "checking") return <Clock3 className="h-3.5 w-3.5" aria-hidden="true" />;
  if (status === "fail" || status === "blocked") return <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />;
  return <CircleDashed className="h-3.5 w-3.5" aria-hidden="true" />;
}

function statusClass(status: ReadinessGateSummary["status"]) {
  if (status === "pass") return "bg-[#9aa889]/18 text-[#17281f]";
  if (status === "checking") return "bg-[#17281f]/10 text-[#17281f]";
  if (status === "fail" || status === "blocked") return "bg-[#d6653b]/14 text-[#7a2c17]";
  return "bg-[#17281f]/6 text-[#17281f]/62";
}

export function ReadinessChecklist({ gates }: { gates: ReadinessGateSummary[] }) {
  return (
    <div className="space-y-2">
      {gates.map((gate) => (
        <div key={gate.id} className="flex items-start gap-3 rounded-md border border-[#17281f]/10 bg-white/45 p-3">
          <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${statusClass(gate.status)}`}>
            {statusIcon(gate.status)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-[#111612]">{gate.message}</span>
            {gate.remediation && (
              <span className="mt-0.5 block text-xs leading-5 text-[#17281f]/62">{gate.remediation}</span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}
