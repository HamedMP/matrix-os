import type { ProjectSetupDraft } from "@matrix-os/contracts";
import { borderStyle, mutedStyle } from "./ProjectSetupAction.js";

export function ProjectSetupReviewSummary({ draft, connected }: { draft: ProjectSetupDraft; connected: boolean }) {
  const mcpLabel = connected ? `${draft.mcp.service} connected on this computer`
    : draft.mcp.state === "pending" ? "Authorization pending"
    : "Skipped";
  const rows = [
    ["Project guidance", draft.answers.purpose],
    ["Project skill", draft.skill?.name ?? (draft.answers.skillInstructions ? "Needs a draft" : "Skipped")],
    ["MCP", mcpLabel],
  ];
  return (
    <dl className="divide-y divide-[var(--border-subtle,var(--border))] rounded-lg border px-3" style={borderStyle} aria-label="Project setup summary">
      {rows.map(([label, value]) => (
        <div className="flex min-w-0 items-baseline justify-between gap-4 py-2 text-xs" key={label}>
          <dt className="shrink-0 font-medium">{label}</dt>
          <dd className="min-w-0 text-right [overflow-wrap:anywhere]" style={mutedStyle}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
