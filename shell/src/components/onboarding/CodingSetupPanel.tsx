"use client";

import { CheckCircle2Icon, CircleDashedIcon, ExternalLinkIcon, GitBranchIcon, TerminalIcon } from "lucide-react";
import type { ReadinessGateSummary } from "@/hooks/useOnboarding";
import { terminalContextLaunchPath } from "@/lib/app-launch";

const CODING_GATE_LABELS: Record<string, string> = {
  "github.connected": "GitHub connected",
  "project.selected": "Project selected",
  "issue_source.selected": "Choose task source",
  "symphony.ready": "Symphony ready",
  "terminal.ready": "Terminal context",
};

function gateTone(status: ReadinessGateSummary["status"]) {
  if (status === "pass") return "border-[#4f7f5c]/25 bg-[#4f7f5c]/10 text-[#213829]";
  if (status === "fail" || status === "blocked") return "border-[#b4532f]/25 bg-[#b4532f]/10 text-[#5f2b1e]";
  return "border-[#17281f]/10 bg-white/45 text-[#17281f]/70";
}

export function CodingSetupPanel({
  gates,
  onOpenTerminal,
}: {
  gates: ReadinessGateSummary[];
  onOpenTerminal: (path: string) => void;
}) {
  const codingGates = gates.filter((gate) => Object.prototype.hasOwnProperty.call(CODING_GATE_LABELS, gate.id));
  if (codingGates.length === 0) return null;
  const projectGate = codingGates.find((gate) => gate.id === "project.selected");
  const projectSlug = projectGate?.evidence?.[0] ?? null;
  const terminalLaunchPath = terminalContextLaunchPath(projectSlug);

  return (
    <section className="rounded-md border border-[#17281f]/10 bg-[#f8f5ee]/80 p-4 shadow-[0_16px_45px_rgba(23,40,31,0.08)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-[#111612]">
            <GitBranchIcon className="h-4 w-4 text-[#a6542f]" aria-hidden="true" />
            Coding setup
          </h2>
          <p className="mt-1 max-w-xl text-xs leading-5 text-[#17281f]/62">
            Matrix uses this path to connect GitHub, pick the project, choose the work source, start Symphony once, and open the matching terminal context when you need to inspect the workspace.
          </p>
        </div>
        <button
          type="button"
          onClick={() => onOpenTerminal(terminalLaunchPath)}
          data-terminal-launch={terminalLaunchPath}
          className="inline-flex min-h-9 shrink-0 items-center gap-2 rounded-md border border-[#17281f]/15 bg-white/70 px-3 text-xs font-medium text-[#17281f] transition hover:border-[#17281f]/30"
        >
          <TerminalIcon className="h-4 w-4" aria-hidden="true" />
          Open terminal context
        </button>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {codingGates.map((gate) => (
          <div key={gate.id} className={`rounded-md border p-3 ${gateTone(gate.status)}`}>
            <div className="flex items-center gap-2">
              {gate.status === "pass" ? (
                <CheckCircle2Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
              ) : (
                <CircleDashedIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
              )}
              <p className="text-xs font-semibold">{CODING_GATE_LABELS[gate.id]}</p>
            </div>
            <p className="mt-1 text-xs leading-5 opacity-80">{gate.message}</p>
            {gate.remediation && (
              <p className="mt-2 inline-flex items-center gap-1 text-xs font-medium">
                <ExternalLinkIcon className="h-3.5 w-3.5" aria-hidden="true" />
                {gate.remediation}
              </p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
