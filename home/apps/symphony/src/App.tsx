import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ExternalLink, FolderOpen, RefreshCw, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

type RunGroup = "queue" | "running" | "needsAttention" | "done";
const RUN_GROUPS: RunGroup[] = ["queue", "running", "needsAttention", "done"];

interface SymphonyRun {
  issueIdentifier: string | null;
  issueId?: string | null;
  status: string;
  state?: string | null;
  sessionId?: string | null;
  turnCount?: number;
  latestEvent?: string | null;
  latestMessage?: string | null;
  updatedAt?: string | null;
  attempt?: number;
  allowedActions?: string[];
}

interface SymphonyState {
  service: {
    status: "ready" | "degraded" | "unavailable";
    credentialStatus?: "connected" | "setup_required" | "unavailable" | "not_required";
    generatedAt: string | null;
  };
  groups: Record<RunGroup, SymphonyRun[]>;
}

interface SymphonyIssueDetail {
  issueIdentifier: string | null;
  issueId: string | null;
  status: string;
  sessionId: string | null;
  turnCount: number;
  latestEvent: string | null;
  latestMessage: string | null;
  workspacePath: string | null;
  workpadUrl: string | null;
  logs: unknown;
  recentEvents: Array<{ at?: string; event?: string; message?: string } | unknown>;
  retry: { attempt: number; dueAt: string | null } | null;
  allowedActions: string[];
}

interface MatrixOSBridge {
  openApp?: (name: string, path: string) => void;
}

declare global {
  interface Window {
    MatrixOS?: MatrixOSBridge;
  }
}

const EMPTY_STATE: SymphonyState = {
  service: { status: "unavailable", generatedAt: null },
  groups: { queue: [], running: [], needsAttention: [], done: [] },
};

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    signal: init?.signal ?? AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("request_failed");
  return await response.json() as T;
}

function allRuns(state: SymphonyState): SymphonyRun[] {
  return [...state.groups.running, ...state.groups.needsAttention, ...state.groups.queue, ...state.groups.done];
}

function groupLabel(group: RunGroup): string {
  if (group === "needsAttention") return "Needs Attention";
  if (group === "done") return "Done / Handoff";
  return group[0].toUpperCase() + group.slice(1);
}

function tone(status: string): string {
  if (status === "running") return "bg-emerald-100 text-emerald-800";
  if (status === "queued") return "bg-sky-100 text-sky-800";
  if (status === "needs_attention" || status === "retrying" || status === "failed") return "bg-amber-100 text-amber-900";
  return "bg-zinc-100 text-zinc-700";
}

function eventText(run: SymphonyRun): string {
  return run.latestMessage || run.latestEvent || run.state || "No events yet";
}

function safeIssue(issueIdentifier: string | null | undefined): string | null {
  return issueIdentifier && /^[A-Z][A-Z0-9]{1,12}-[0-9]{1,10}$/.test(issueIdentifier) ? issueIdentifier : null;
}

function chooseActiveIssue(state: SymphonyState, currentIssue: string | null, preferredIssue?: string | null): string | null {
  const runs = allRuns(state);
  const candidates = [safeIssue(currentIssue), safeIssue(preferredIssue), safeIssue(runs[0]?.issueIdentifier)];
  return candidates.find((candidate) => Boolean(candidate) && runs.some((run) => safeIssue(run.issueIdentifier) === candidate)) ?? null;
}

function openWorkspace(path: string | null) {
  if (!path) return;
  if (window.MatrixOS?.openApp) {
    window.MatrixOS.openApp("Workspace", path);
    return;
  }
  window.parent.postMessage({
    type: "os:open-app",
    app: "Symphony",
    payload: { name: "Workspace", path },
  }, window.location.origin);
}

function flattenLogs(logs: unknown): string[] {
  if (!logs || typeof logs !== "object") return [];
  const values = Object.values(logs as Record<string, unknown>);
  return values.flatMap((value) => {
    if (!Array.isArray(value)) return [];
    return value.map((entry) => typeof entry === "string" ? entry : JSON.stringify(entry));
  }).slice(0, 100);
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function withTimeoutSignal(signal: AbortSignal, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (typeof AbortSignal.any === "function") return AbortSignal.any([signal, timeoutSignal]);
  if (signal.aborted) return signal;
  if (timeoutSignal.aborted) return timeoutSignal;

  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  timeoutSignal.addEventListener("abort", abort, { once: true });
  return controller.signal;
}

export default function App() {
  const [state, setState] = useState<SymphonyState>(EMPTY_STATE);
  const [selectedIssue, setSelectedIssue] = useState<string | null>(null);
  const [detail, setDetail] = useState<SymphonyIssueDetail | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const selectedIssueRef = useRef<string | null>(null);
  const detailAbortRef = useRef<AbortController | null>(null);
  const detailRequestRef = useRef(0);

  const runs = useMemo(() => allRuns(state), [state]);
  const activeIssue = selectedIssue ?? safeIssue(runs[0]?.issueIdentifier);

  const setActiveIssue = useCallback((issueIdentifier: string | null) => {
    selectedIssueRef.current = issueIdentifier;
    setSelectedIssue(issueIdentifier);
  }, []);

  const loadIssueDetail = useCallback(async (issueIdentifier: string) => {
    detailAbortRef.current?.abort();
    const controller = new AbortController();
    const requestId = detailRequestRef.current + 1;
    detailRequestRef.current = requestId;
    detailAbortRef.current = controller;

    try {
      const signal = withTimeoutSignal(controller.signal, 10_000);
      const nextDetail = await fetchJson<SymphonyIssueDetail>(`/api/symphony/issues/${issueIdentifier}`, { signal });
      if (detailRequestRef.current === requestId) setDetail(nextDetail);
    } catch (err: unknown) {
      if (controller.signal.aborted) return;
      throw err;
    } finally {
      if (detailRequestRef.current === requestId) detailAbortRef.current = null;
    }
  }, []);

  const loadState = useCallback(async (preferredIssue?: string | null) => {
    setError(null);
    const next = await fetchJson<SymphonyState>("/api/symphony/state");
    setState(next);
    const nextActive = chooseActiveIssue(next, selectedIssueRef.current, preferredIssue);
    setActiveIssue(nextActive);
    setLoading(false);
    if (nextActive) {
      try {
        await loadIssueDetail(nextActive);
      } catch (err: unknown) {
        if (isAbortError(err)) return;
        console.warn("[symphony] issue detail failed:", err instanceof Error ? err.message : String(err));
        setError("Issue detail could not be loaded.");
      }
    } else {
      detailAbortRef.current?.abort();
      setDetail(null);
    }
  }, [loadIssueDetail, setActiveIssue]);

  useEffect(() => {
    void loadState().catch((err: unknown) => {
      console.warn("[symphony] state load failed:", err instanceof Error ? err.message : String(err));
      setError("Symphony is unavailable.");
      setLoading(false);
    });
  }, [loadState]);

  useEffect(() => () => {
    detailAbortRef.current?.abort();
  }, []);

  async function refresh() {
    setBusy("refresh");
    setError(null);
    try {
      await fetchJson("/api/symphony/refresh", { method: "POST", body: "{}" });
      await loadState(activeIssue);
    } catch (err: unknown) {
      console.warn("[symphony] refresh failed:", err instanceof Error ? err.message : String(err));
      setError("Symphony refresh failed.");
    } finally {
      setBusy(null);
    }
  }

  async function stopCurrent() {
    if (!activeIssue) return;
    setBusy("stop");
    setError(null);
    try {
      await fetchJson(`/api/symphony/runs/${activeIssue}/stop`, { method: "POST", body: "{}" });
      await loadState(activeIssue);
    } catch (err: unknown) {
      console.warn("[symphony] stop failed:", err instanceof Error ? err.message : String(err));
      setError("Symphony stop failed.");
    } finally {
      setBusy(null);
    }
  }

  function selectIssue(issueIdentifier: string | null | undefined) {
    const safe = safeIssue(issueIdentifier);
    if (!safe) return;
    setActiveIssue(safe);
    setBusy("detail");
    const detailPromise = loadIssueDetail(safe);
    const thisRequestId = detailRequestRef.current;
    void detailPromise
      .catch((err: unknown) => {
        if (isAbortError(err)) return;
        console.warn("[symphony] issue detail failed:", err instanceof Error ? err.message : String(err));
        setError("Issue detail could not be loaded.");
      })
      .finally(() => {
        if (detailRequestRef.current === thisRequestId) setBusy(null);
      });
  }

  const logLines = flattenLogs(detail?.logs);

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b bg-white px-5 py-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-normal">Symphony</h1>
          <p className="truncate text-sm text-muted-foreground">Elixir runtime via Codex app-server</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => void refresh()} disabled={Boolean(busy)}>
            <RefreshCw className="size-4" /> Refresh
          </Button>
          <Button variant="outline" onClick={() => void stopCurrent()} disabled={!activeIssue || Boolean(busy)}>
            <Square className="size-4" /> Stop
          </Button>
        </div>
      </header>

      {error && (
        <div className="mx-5 mt-4 flex items-center gap-2 border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <AlertTriangle className="size-4" /> {error}
        </div>
      )}

      <section className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Queue" value={state.groups.queue.length} />
        <Metric label="Running" value={state.groups.running.length} />
        <Metric label="Needs Attention" value={state.groups.needsAttention.length} />
        <Metric label="Done / Handoff" value={state.groups.done.length} />
      </section>

      {loading && (
        <div className="mx-5 mb-4 border bg-white px-4 py-3 text-sm text-muted-foreground">
          Loading Symphony state...
        </div>
      )}

      {state.service.credentialStatus === "setup_required" && (
        <div className="mx-5 mb-4 border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Connect Linear in Matrix Integrations to let Symphony poll assigned work.
        </div>
      )}

      <section className="grid gap-5 px-5 pb-5 lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
        <div className="space-y-4">
          {RUN_GROUPS.map((group) => (
            <section key={group} className="border bg-white">
              <div className="flex items-center justify-between border-b px-4 py-3">
                <h2 className="text-sm font-semibold uppercase tracking-normal text-muted-foreground">{groupLabel(group)}</h2>
                <span className="text-sm text-muted-foreground">{state.groups[group].length}</span>
              </div>
              <div className="divide-y">
                {state.groups[group].length === 0 ? (
                  <div className="px-4 py-6 text-sm text-muted-foreground">No runs in this group.</div>
                ) : state.groups[group].map((run, index) => (
                  <button
                    key={`${group}-${run.issueIdentifier ?? run.issueId ?? run.sessionId ?? String(index)}`}
                    type="button"
                    className="block w-full px-4 py-3 text-left hover:bg-zinc-50 disabled:opacity-50"
                    disabled={Boolean(busy)}
                    onClick={() => selectIssue(run.issueIdentifier)}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{run.issueIdentifier ?? "Unknown issue"}</span>
                      <Badge className={tone(run.status)}>{run.status}</Badge>
                      {run.sessionId && <span className="text-xs text-muted-foreground">session {run.sessionId}</span>}
                    </div>
                    <p className="mt-1 break-words text-sm text-muted-foreground">{eventText(run)}</p>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>

        <aside className="border bg-white p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="truncate text-base font-semibold">{detail?.issueIdentifier ?? activeIssue ?? "No active issue"}</h2>
              <p className="text-sm text-muted-foreground">Service: {state.service.status}</p>
              <p className="text-sm text-muted-foreground">Linear: {state.service.credentialStatus ?? "unavailable"}</p>
            </div>
            {detail?.workpadUrl && (
              <Button variant="outline" size="sm" onClick={() => window.open(detail.workpadUrl!, "_blank", "noopener,noreferrer")}>
                <ExternalLink className="size-4" /> Workpad
              </Button>
            )}
          </div>

          <div className="mt-4 space-y-2 text-sm">
            <Info label="Status" value={detail?.status ?? "Idle"} />
            <Info label="Session" value={detail?.sessionId ?? "None"} />
            <Info label="Turns" value={String(detail?.turnCount ?? 0)} />
            <Info label="Latest event" value={detail?.latestEvent ?? "None"} />
            <Info label="Workspace" value={detail?.workspacePath ?? "Unavailable"} />
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => openWorkspace(detail?.workspacePath ?? null)} disabled={!detail?.workspacePath}>
              <FolderOpen className="size-4" /> Workspace
            </Button>
          </div>

          <section className="mt-5 border-t pt-4">
            <h3 className="text-sm font-semibold">Logs</h3>
            <div className="mt-2 max-h-72 overflow-auto bg-zinc-950 p-3 font-mono text-xs text-zinc-100">
              {logLines.length === 0 ? (
                <div className="text-zinc-400">No logs available.</div>
              ) : logLines.map((line, index) => (
                <div key={`${index}-${line.slice(0, 24)}`} className="break-words">{line}</div>
              ))}
            </div>
          </section>
        </aside>
      </section>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="border bg-white px-4 py-3">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words font-medium">{value}</span>
    </div>
  );
}
