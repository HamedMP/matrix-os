import type { CSSProperties } from "react";
import type { AgentInboxPill } from "./agent-inbox-model.js";

const muted: CSSProperties = { color: "var(--text-tertiary, var(--muted-foreground))" };

/** Status pill colors shared by the agent inbox and project conversation rows. */
export const AGENT_INBOX_PILL_STYLE: Record<AgentInboxPill, CSSProperties> = {
  Approval: { background: "rgba(214,69,65,0.12)", color: "#C2413B" },
  Failed: { background: "rgba(214,69,65,0.12)", color: "#C2413B" },
  Question: { background: "rgba(224,161,46,0.16)", color: "#A86F0D" },
  "Needs you": { background: "rgba(224,161,46,0.16)", color: "#A86F0D" },
  Stalled: { background: "rgba(224,161,46,0.16)", color: "#A86F0D" },
  Running: { background: "rgba(59,165,93,0.14)", color: "#2E8A4C" },
  Done: { border: "1px solid var(--border-subtle, var(--border))", ...muted },
  Stopped: { border: "1px solid var(--border-subtle, var(--border))", ...muted },
  App: { border: "1px solid var(--border-subtle, var(--border))", ...muted },
};
