import { useEffect } from "react";
import type { ApiClient } from "./api";
import type { ShellSessionSummary } from "../stores/shell-sessions";
import { useShellSessions } from "../stores/shell-sessions";
import { useTabs } from "../stores/tabs";

export const SHELL_SESSION_SYNC_INTERVAL_MS = 5_000;

type AcceptSnapshot = () => boolean;

export function reconcileShellSessionSnapshot(sessions: ShellSessionSummary[]): void {
  useTabs.getState().reconcileTerminalSessions(sessions.map((session) => session.name));
}

export async function syncShellSessions(
  api: ApiClient,
  acceptSnapshot: AcceptSnapshot = () => true,
): Promise<ShellSessionSummary[] | null> {
  const sessions = await useShellSessions.getState().load(api);
  if (sessions === null || !acceptSnapshot()) return null;
  reconcileShellSessionSnapshot(sessions);
  return sessions;
}

export function startShellSessionSync(api: ApiClient): () => void {
  let stopped = false;
  let refreshInFlight = false;

  const refresh = (requireVisible: boolean) => {
    if (stopped || refreshInFlight) return;
    if (requireVisible && document.visibilityState !== "visible") return;
    refreshInFlight = true;
    void syncShellSessions(api, () => !stopped)
      .catch(() => {
        // The store normalizes expected request failures. This guard prevents
        // an unexpected implementation error from becoming an unhandled task.
        console.error("[shell-session-sync] Unexpected refresh failure");
      })
      .finally(() => {
        refreshInFlight = false;
      });
  };

  const refreshWhenVisible = () => refresh(true);
  refresh(false);
  const interval = window.setInterval(refreshWhenVisible, SHELL_SESSION_SYNC_INTERVAL_MS);
  window.addEventListener("focus", refreshWhenVisible);
  document.addEventListener("visibilitychange", refreshWhenVisible);

  return () => {
    stopped = true;
    window.clearInterval(interval);
    window.removeEventListener("focus", refreshWhenVisible);
    document.removeEventListener("visibilitychange", refreshWhenVisible);
  };
}

export function useShellSessionSync(api: ApiClient | null, runtimeScope: string): void {
  useEffect(() => {
    if (!api) return;
    return startShellSessionSync(api);
  }, [api, runtimeScope]);
}
