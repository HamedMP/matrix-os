"use client";

import { BotIcon, CheckCircle2Icon, KeyRoundIcon, PlusIcon } from "lucide-react";
import type { AgentCredentialStatus } from "@/hooks/useAgentCredentialStatus";

function agentLabel(agent: string) {
  if (agent === "claude") return "Claude";
  if (agent === "codex") return "Codex";
  return "Hermes";
}

function statusCopy(agent: string, status: string) {
  if (agent === "hermes") return "Hermes is the Matrix system agent";
  if (status === "available") return `${agentLabel(agent)} is connected`;
  return `${agentLabel(agent)} is not connected`;
}

export function AgentCredentialPanel({
  status,
  error,
  onVerify,
}: {
  status: AgentCredentialStatus | null;
  error?: string | null;
  onVerify: (agent: "claude" | "codex") => void;
}) {
  const agents = status?.agents ?? [
    {
      agent: "hermes" as const,
      status: "available" as const,
      coordinationRole: "system_agent" as const,
      workflows: ["app_building", "assistant", "integrations"],
      degradedWorkflows: [],
      verifiedAt: null,
      nextAction: null,
    },
  ];

  return (
    <section className="rounded-md border border-[#17281f]/10 bg-white/55 p-4 shadow-[0_16px_45px_rgba(23,40,31,0.08)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-[#111612]">
            <KeyRoundIcon className="h-4 w-4 text-[#a6542f]" aria-hidden="true" />
            Agent setup
          </h2>
          <p className="mt-1 max-w-xl text-xs leading-5 text-[#17281f]/62">
            {status?.routingExplanation ?? "Hermes remains the Matrix system agent while Claude and Codex add optional specialist paths when connected."}
          </p>
          {error && (
            <p className="mt-2 rounded-md border border-[#b4532f]/20 bg-[#b4532f]/10 px-2 py-1.5 text-xs leading-5 text-[#5f2b1e]">
              {error}
            </p>
          )}
        </div>
        <div className="rounded-full border border-[#4f7f5c]/20 bg-[#4f7f5c]/10 px-2.5 py-1 text-xs font-medium text-[#213829]">
          System agent: Hermes
        </div>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        {agents.map((agent) => {
          const verifyAgent = agent.agent === "claude" || agent.agent === "codex" ? agent.agent : null;
          return (
            <div key={agent.agent} className="rounded-md border border-[#17281f]/10 bg-[#f8f5ee]/75 p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <BotIcon className="h-4 w-4 text-[#17281f]/70" aria-hidden="true" />
                  <p className="text-xs font-semibold text-[#111612]">{agentLabel(agent.agent)}</p>
                </div>
                {agent.status === "available" && <CheckCircle2Icon className="h-4 w-4 text-[#4f7f5c]" aria-hidden="true" />}
              </div>
              <p className="mt-2 text-xs leading-5 text-[#17281f]/68">{statusCopy(agent.agent, agent.status)}</p>
              <p className="mt-1 text-xs capitalize text-[#17281f]/48">{agent.coordinationRole.replaceAll("_", " ")}</p>
              {agent.nextAction && verifyAgent && (
                <button
                  type="button"
                  onClick={() => onVerify(verifyAgent)}
                  className="mt-3 inline-flex min-h-8 items-center gap-1.5 rounded-md border border-[#17281f]/12 bg-white/70 px-2.5 text-xs font-medium text-[#17281f] transition hover:border-[#17281f]/28"
                >
                  <PlusIcon className="h-3.5 w-3.5" aria-hidden="true" />
                  {agent.nextAction}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
