import { useCallback, useEffect, useState } from "react";

export type SetupStepId = "agent" | "github" | "repo";
type Status = "done" | "active" | "pending";

const DISMISS_KEY = "matrix:setup-checklist-dismissed";

export function useSetupChecklist() {
  const [agentDone, setAgentDone] = useState(false);
  const [githubDone, setGithubDone] = useState(false);
  const [repoDone, setRepoDone] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const refresh = useCallback(() => {
    void fetch("/api/agents/credentials/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setAgentDone(Boolean(d?.agents?.some((a: any) => a.available))))
      .catch((err: unknown) => console.warn("[setup] agent status failed:", err instanceof Error ? err.name : typeof err));
    void fetch("/api/github/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setGithubDone(Boolean(d?.authenticated)))
      .catch((err: unknown) => console.warn("[setup] github status failed:", err instanceof Error ? err.name : typeof err));
    void fetch("/api/workspace/projects")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setRepoDone(Array.isArray(d?.projects) ? d.projects.length > 0 : false))
      .catch((err: unknown) => console.warn("[setup] projects failed:", err instanceof Error ? err.name : typeof err));
  }, []);

  useEffect(() => {
    try { setDismissed(sessionStorage.getItem(DISMISS_KEY) === "1"); } catch { /* sandbox: ignore */ }
    refresh();
  }, [refresh]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    try { sessionStorage.setItem(DISMISS_KEY, "1"); } catch { /* sandbox: ignore */ }
  }, []);

  const done: Record<SetupStepId, boolean> = { agent: agentDone, github: githubDone, repo: repoDone };
  const order: SetupStepId[] = ["agent", "github", "repo"];
  const activeId = order.find((id) => !done[id]) ?? "repo";
  const steps = order.map((id) => ({
    id,
    status: (done[id] ? "done" : id === activeId ? "active" : "pending") as Status,
  }));

  return { steps, activeId, dismissed, dismiss, refresh };
}
