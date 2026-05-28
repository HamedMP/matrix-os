"use client";

import { Brain, Code2, Hammer, Sparkles } from "lucide-react";
import type { OnboardingGoalId } from "@/hooks/useOnboarding";

const goals: Array<{
  id: OnboardingGoalId;
  title: string;
  description: string;
  icon: typeof Code2;
}> = [
  { id: "coding", title: "Code with Matrix", description: "GitHub, projects, Symphony, terminal, and handoff.", icon: Code2 },
  { id: "app_building", title: "Build an app", description: "Hermes guides an app from idea to working Matrix surface.", icon: Hammer },
  { id: "assistant", title: "Use an assistant", description: "Calendar, email, summaries, and approved operating tasks.", icon: Sparkles },
  { id: "company_brain", title: "Run company brain", description: "Product context, customer notes, support, and growth memory.", icon: Brain },
];

export function GoalSelector({
  selectedGoalIds,
  onSelect,
}: {
  selectedGoalIds: OnboardingGoalId[];
  onSelect: (goalId: OnboardingGoalId) => void;
}) {
  return (
    <div className="grid gap-2">
      {goals.map((goal) => {
        const Icon = goal.icon;
        const selected = selectedGoalIds.includes(goal.id);
        return (
          <button
            key={goal.id}
            type="button"
            onClick={() => onSelect(goal.id)}
            className={`flex min-h-[72px] w-full items-center gap-3 rounded-md border p-3 text-left transition ${
              selected
                ? "border-[#d6653b]/70 bg-[#d6653b]/10 text-[#111612]"
                : "border-[#17281f]/10 bg-white/45 text-[#17281f] hover:border-[#17281f]/25"
            }`}
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[#17281f] text-[#f4f0e8]">
              <Icon className="h-4 w-4" aria-hidden="true" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold">{goal.title}</span>
              <span className="mt-0.5 block text-xs leading-5 text-[#17281f]/65">{goal.description}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

