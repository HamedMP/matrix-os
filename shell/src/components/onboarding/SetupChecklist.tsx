import { palette as c, fonts } from "@matrix-os/brand";
import { useSetupChecklist, type SetupStepId } from "@/hooks/useSetupChecklist";
import { AgentStep } from "./steps/AgentStep";
import { GithubStep } from "./steps/GithubStep";
import { RepoStep } from "./steps/RepoStep";

const STEP_META: Record<SetupStepId, { title: string }> = {
  agent: { title: "Connect a coding agent" },
  github: { title: "Connect GitHub" },
  repo: { title: "Clone or import a repo" },
};

export function SetupChecklist({ onOpenTerminal }: { onOpenTerminal: (path: string) => void }) {
  const { steps, activeId, dismissed, dismiss, refresh } = useSetupChecklist();
  if (dismissed) return null;
  const doneCount = steps.filter((s) => s.status === "done").length;

  return (
    <div style={{ maxWidth: 400, background: c.card, border: `1px solid ${c.border}`, borderRadius: 14, boxShadow: "0 24px 60px rgba(50,53,46,0.12)", padding: 18 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
        <div>
          <p style={{ fontFamily: fonts.display, fontSize: 25, lineHeight: 1.05, color: c.deep, margin: 0 }}>Set up your workspace</p>
          <p style={{ fontSize: 12, color: c.subtle, marginTop: 3 }}>Explore the canvas anytime — this stays here until you're done.</p>
        </div>
        <span style={{ fontSize: 11, fontWeight: 500, color: c.mutedFg, whiteSpace: "nowrap", background: "rgba(67,78,63,0.06)", padding: "5px 9px", borderRadius: 999 }}>{doneCount} of 3</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 15 }}>
        <AgentStep status={steps[0].status} expanded={activeId === "agent"} title={STEP_META.agent.title} onOpenTerminal={onOpenTerminal} onChange={refresh} />
        <GithubStep status={steps[1].status} expanded={activeId === "github"} title={STEP_META.github.title} onOpenTerminal={onOpenTerminal} onChange={refresh} />
        <RepoStep status={steps[2].status} expanded={activeId === "repo"} title={STEP_META.repo.title} onChange={refresh} />
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 15, paddingTop: 13, borderTop: `1px solid ${c.border}` }}>
        <button type="button" onClick={dismiss} style={{ fontSize: 12, color: c.subtle, background: "none", border: "none", cursor: "pointer" }}>Skip for now</button>
      </div>
    </div>
  );
}
