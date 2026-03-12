"use client";

// Inspired by AI Elements plan pattern, consistent with MissionControl TaskCard
import type { HTMLAttributes } from "react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronDownIcon, CheckCircle2Icon, CircleIcon } from "lucide-react";

export interface PlanStep {
  title: string;
  description?: string;
  completed?: boolean;
}

export type PlanProps = HTMLAttributes<HTMLDivElement> & {
  steps: PlanStep[];
  title?: string;
};

export function Plan({
  steps,
  title = "Plan",
  className,
  ...props
}: PlanProps) {
  const completedCount = steps.filter((s) => s.completed).length;
  const total = steps.length;
  const progress = total > 0 ? Math.round((completedCount / total) * 100) : 0;

  return (
    <div
      className={cn(
        "rounded-md border bg-card/50 p-3 space-y-3",
        className,
      )}
      {...props}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-xs text-muted-foreground">
          {completedCount}/{total}
        </span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
        <div
          className="h-full rounded-full bg-primary transition-all duration-300 ease-out"
          style={{ width: `${progress}%` }}
        />
      </div>
      <div className="space-y-1">
        {steps.map((step, i) => (
          <PlanStepItem key={`${step.title}-${i}`} step={step} index={i} />
        ))}
      </div>
    </div>
  );
}

type PlanStepItemProps = {
  step: PlanStep;
  index: number;
};

function PlanStepItem({ step, index }: PlanStepItemProps) {
  const [open, setOpen] = useState(false);
  const hasDescription = Boolean(step.description);

  const content = (
    <div className="flex items-start gap-2 py-1">
      {step.completed ? (
        <CheckCircle2Icon className="size-4 shrink-0 text-green-600 mt-0.5" />
      ) : (
        <CircleIcon className="size-4 shrink-0 text-muted-foreground mt-0.5" />
      )}
      <span
        className={cn(
          "text-xs",
          step.completed && "text-muted-foreground line-through",
        )}
      >
        {index + 1}. {step.title}
      </span>
    </div>
  );

  if (!hasDescription) return content;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center justify-between">
        {content}
        <ChevronDownIcon
          className={cn(
            "size-3 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <p className="pl-6 text-xs text-muted-foreground pb-1">
          {step.description}
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function parsePlan(content: string): PlanStep[] | null {
  const match = content.match(
    /```plan\n([\s\S]*?)```/,
  );
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[1]);
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (s): s is PlanStep =>
          typeof s === "object" && s !== null && typeof s.title === "string",
      );
    }
  } catch {
    // ignore parse errors
  }
  return null;
}
