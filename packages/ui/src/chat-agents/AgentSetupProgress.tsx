import { Check } from "lucide-react";

const stages = ["Discuss", "Resources", "Review"] as const;

export function AgentSetupProgress({ stage, hasRole, hasResources }: {
  stage: typeof stages[number]; hasRole: boolean; hasResources: boolean;
}) {
  return <nav aria-label="Agent setup progress">
    <ol className="grid w-full max-w-[434px] grid-cols-3 gap-2 text-xs">
      {stages.map((label, index) => {
        const current = stage === label;
        const done = !current && (label === "Discuss" && hasRole || label === "Resources" && hasResources);
        return <li key={label} aria-current={current ? "step" : undefined}
          style={{ backgroundColor: current ? "var(--success-muted, color-mix(in srgb, var(--success) 14%, var(--bg-surface, var(--muted))))" : "var(--bg-sunken, var(--muted))" }}
          className={`flex min-h-[30px] min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 ${current ? "font-medium text-[var(--success-text,var(--foreground))]" : "text-[var(--text-secondary,var(--muted-foreground))]"}`}>
          {done ? <Check aria-hidden size={12}/> : <span aria-hidden>{index + 1}</span>}
          <span>{label}</span>{done ? <span className="sr-only">complete</span> : null}
        </li>;
      })}
    </ol>
  </nav>;
}
