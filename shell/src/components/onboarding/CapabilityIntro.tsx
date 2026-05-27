"use client";

import { Bot, CalendarPlus, Code2, Mail, PanelsTopLeft, Share2 } from "lucide-react";

const capabilities = [
  { icon: Code2, title: "Ship code", description: "Connect GitHub, select a project, start Symphony, and inspect terminal context." },
  { icon: PanelsTopLeft, title: "Build apps", description: "Ask Hermes to create Matrix apps and guide app-building work." },
  { icon: Bot, title: "Operate tasks", description: "Use Hermes as the Matrix system agent, with Claude or Codex as optional specialists." },
  { icon: Mail, title: "Read and summarize", description: "Approve email and knowledge workflows before agents use them." },
  { icon: CalendarPlus, title: "Act through tools", description: "Add events, update work items, and summarize outcomes with safe action logs." },
  { icon: Share2, title: "Grow the company", description: "Draft support, acquisition, social, and follow-up work with review gates." },
] as const;

export function CapabilityIntro() {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {capabilities.map((capability) => {
        const Icon = capability.icon;
        return (
          <div key={capability.title} className="rounded-md border border-[#17281f]/10 bg-[#f4f0e8]/70 p-3">
            <div className="mb-3 flex h-8 w-8 items-center justify-center rounded-md bg-[#17281f] text-[#f4f0e8]">
              <Icon className="h-4 w-4" aria-hidden="true" />
            </div>
            <h2 className="text-sm font-semibold text-[#111612]">{capability.title}</h2>
            <p className="mt-1 text-xs leading-5 text-[#17281f]/65">{capability.description}</p>
          </div>
        );
      })}
    </div>
  );
}

