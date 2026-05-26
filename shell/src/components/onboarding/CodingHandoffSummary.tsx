"use client";

import { BotIcon, CheckCircle2Icon } from "lucide-react";

export function CodingHandoffSummary({
  activeAgents,
  status,
}: {
  activeAgents: Array<"claude" | "codex" | "hermes">;
  status: "idle" | "running" | "needs_input" | "ready" | "failed" | null;
}) {
  const agents = activeAgents.length > 0 ? activeAgents : ["hermes" as const];
  const statusLabel = !status || status === "idle"
    ? "Idle"
    : status === "needs_input"
      ? "Needs input"
      : status.replaceAll("_", " ");
  return (
    <section className="rounded-md border border-[#17281f]/10 bg-[#17281f]/5 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-[#111612]">
            <BotIcon className="h-4 w-4 text-[#a6542f]" aria-hidden="true" />
            Coding handoff
          </h2>
          <p className="mt-1 text-xs leading-5 text-[#17281f]/62">
            Active coding work will summarize the branch, validation state, next action, and whether it needs your input before another agent run starts.
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-1.5">
          <span className="inline-flex items-center gap-1 rounded-full border border-[#17281f]/10 bg-white/60 px-2.5 py-1 text-xs font-medium capitalize text-[#17281f]/75">
            {statusLabel}
          </span>
          {agents.map((agent) => (
            <span key={agent} className="inline-flex items-center gap-1 rounded-full border border-[#17281f]/10 bg-white/60 px-2.5 py-1 text-xs font-medium capitalize text-[#17281f]/75">
              <CheckCircle2Icon className="h-3.5 w-3.5 text-[#4f7f5c]" aria-hidden="true" />
              {agent}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
