import { useCallback, useEffect, useState } from "react";
import { getGatewayUrl } from "@/lib/gateway";

export type SetupStepId = "agent" | "github" | "repo";
type Status = "done" | "active" | "pending";

const DISMISS_KEY = "matrix:setup-checklist-dismissed";
const SETUP_STATUS_TIMEOUT_MS = 10_000;

function logStorageFailure(action: "read" | "write", err: unknown) {
  console.warn("[setup] session storage failed:", action, err instanceof Error ? err.name : typeof err);
}

export function useSetupChecklist() {
  const [agentDone, setAgentDone] = useState(false);
  const [githubDone, setGithubDone] = useState(false);
  const [repoDone, setRepoDone] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const refresh = useCallback(() => {
    void fetch(`${getGatewayUrl()}/api/agents/credentials/status`, { signal: AbortSignal.timeout(SETUP_STATUS_TIMEOUT_MS) })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setAgentDone(Boolean(d?.agents?.some((a: any) => a.available))))
      .catch((err: unknown) => console.warn("[setup] agent status failed:", err instanceof Error ? err.name : typeof err));
    void fetch(`${getGatewayUrl()}/api/github/status`, { signal: AbortSignal.timeout(SETUP_STATUS_TIMEOUT_MS) })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setGithubDone(Boolean(d?.authenticated)))
      .catch((err: unknown) => console.warn("[setup] github status failed:", err instanceof Error ? err.name : typeof err));
    void fetch(`${getGatewayUrl()}/api/workspace/projects`, { signal: AbortSignal.timeout(SETUP_STATUS_TIMEOUT_MS) })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setRepoDone(Array.isArray(d?.projects) ? d.projects.length > 0 : false))
      .catch((err: unknown) => console.warn("[setup] projects failed:", err instanceof Error ? err.name : typeof err));
  }, []);

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(DISMISS_KEY) === "1");
    } catch (err: unknown) {
      logStorageFailure("read", err);
    }
    refresh();
  }, [refresh]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch (err: unknown) {
      logStorageFailure("write", err);
    }
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
