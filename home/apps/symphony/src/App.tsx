import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AlertTriangle, ExternalLink, FolderOpen, Play, Power, RefreshCw, Square } from "lucide-react";
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

interface SymphonyServiceControl {
  available: boolean;
  running: boolean;
  status: "running" | "starting" | "stopping" | "stopped" | "unavailable";
  canStart: boolean;
  canStop: boolean;
  credentialConfigured?: boolean;
  managedBy?: string;
}

interface SymphonyServiceControlResponse {
  service: SymphonyServiceControl;
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
  gatewayFetch?: <T>(url: string, init?: RequestInit, timeoutMs?: number) => Promise<T>;
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

const EMPTY_SERVICE_CONTROL: SymphonyServiceControl = {
  available: false,
  running: false,
  status: "unavailable",
  canStart: false,
  canStop: false,
};

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  if (window.MatrixOS?.gatewayFetch) {
    const { signal: _signal, ...bridgeInit } = init ?? {};
    return await window.MatrixOS.gatewayFetch<T>(url, {
      ...bridgeInit,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    }, 10_000);
  }

  throw new Error("matrix_bridge_unavailable");
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
  return err instanceof DOMException && (err.name === "AbortError" || err.name === "TimeoutError");
}

function isBridgeTimeoutError(err: unknown): boolean {
  return err instanceof Error && err.message === "MatrixOS bridge fetch timed out";
}

function isDetailAbort(err: unknown): boolean {
  return isAbortError(err) || isBridgeTimeoutError(err);
}

function logSymphonyDebug(label: string, err: unknown): void {
  if (!import.meta.env.PROD) {
    console.debug(label, err instanceof Error ? err.message : String(err));
  }
}

export default function App() {
  const [state, setState] = useState<SymphonyState>(EMPTY_STATE);
  const [serviceControl, setServiceControl] = useState<SymphonyServiceControl>(EMPTY_SERVICE_CONTROL);
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
      // react-doctor-disable-next-line react-doctor/async-defer-await -- the bridge request cannot receive AbortSignal over postMessage, so this post-await guard prevents late/stale detail writes after a newer request or unmount aborts the controller.
      const nextDetail = await fetchJson<SymphonyIssueDetail>(`/api/symphony/issues/${issueIdentifier}`);
      if (controller.signal.aborted) return;
      if (detailRequestRef.current === requestId) setDetail(nextDetail);
    } catch (err: unknown) {
      if (controller.signal.aborted) return;
      if (isBridgeTimeoutError(err)) return;
      throw err;
    } finally {
      if (detailRequestRef.current === requestId) detailAbortRef.current = null;
    }
  }, []);

  const loadServiceControl = useCallback(async () => {
    const next = await fetchJson<SymphonyServiceControlResponse>("/api/symphony/service");
    const service = next.service ?? EMPTY_SERVICE_CONTROL;
    setServiceControl(service);
    return service;
  }, []);

  const loadState = useCallback(async (preferredIssue?: string | null) => {
    setError(null);
    const [next] = await Promise.all([
      fetchJson<SymphonyState>("/api/symphony/state"),
      loadServiceControl().catch((err: unknown) => {
        logSymphonyDebug("[symphony] service status failed:", err);
        return null;
      }),
    ]);
    setState(next);
    const nextActive = chooseActiveIssue(next, selectedIssueRef.current, preferredIssue);
    setActiveIssue(nextActive);
    setLoading(false);
    if (nextActive) {
      try {
        await loadIssueDetail(nextActive);
      } catch (err: unknown) {
        if (isDetailAbort(err)) return;
        logSymphonyDebug("[symphony] issue detail failed:", err);
        setError("Issue detail could not be loaded.");
      }
    } else {
      detailAbortRef.current?.abort();
      setDetail(null);
    }
  }, [loadIssueDetail, loadServiceControl, setActiveIssue]);

  useEffect(() => {
    void loadState().catch((err: unknown) => {
      logSymphonyDebug("[symphony] state load failed:", err);
      setError("Symphony is unavailable.");
      setLoading(false);
      void loadServiceControl().catch((serviceErr: unknown) => {
        logSymphonyDebug("[symphony] service status failed:", serviceErr);
      });
    });
  }, [loadState, loadServiceControl]);

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
      logSymphonyDebug("[symphony] refresh failed:", err);
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
      logSymphonyDebug("[symphony] stop failed:", err);
      setError("Symphony stop failed.");
    } finally {
      setBusy(null);
    }
  }

  async function startService() {
    setBusy("service-start");
    setError(null);
    try {
      const next = await fetchJson<SymphonyServiceControlResponse>("/api/symphony/service/start", { method: "POST", body: "{}" });
      setServiceControl(next.service);
      await loadState(activeIssue).catch((stateErr: unknown) => {
        logSymphonyDebug("[symphony] state load after service start failed:", stateErr);
        setLoading(false);
        setError("Symphony is starting.");
      });
    } catch (err: unknown) {
      logSymphonyDebug("[symphony] service start failed:", err);
      setError("Symphony start failed.");
      await loadServiceControl().catch((serviceErr: unknown) => {
        logSymphonyDebug("[symphony] service status failed:", serviceErr);
      });
    } finally {
      setBusy(null);
    }
  }

  async function stopService() {
    setBusy("service-stop");
    setError(null);
    try {
      const next = await fetchJson<SymphonyServiceControlResponse>("/api/symphony/service/stop", { method: "POST", body: "{}" });
      setServiceControl(next.service);
      setState(EMPTY_STATE);
      setActiveIssue(null);
      setDetail(null);
    } catch (err: unknown) {
      logSymphonyDebug("[symphony] service stop failed:", err);
      setError("Symphony stop failed.");
      await loadServiceControl().catch((serviceErr: unknown) => {
        logSymphonyDebug("[symphony] service status failed:", serviceErr);
      });
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
        if (isDetailAbort(err)) return;
        logSymphonyDebug("[symphony] issue detail failed:", err);
        setError("Issue detail could not be loaded.");
      })
      .finally(() => {
        if (detailRequestRef.current === thisRequestId) setBusy(null);
      });
  }

  const logLines = flattenLogs(detail?.logs);

  return (
    <main className="flex h-screen min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <SymphonyHeader
        activeIssue={activeIssue}
        busy={busy}
        serviceControl={serviceControl}
        onRefresh={refresh}
        onStartService={startService}
        onStopCurrent={stopCurrent}
        onStopService={stopService}
      />

      {error && <Notice icon={<AlertTriangle className="size-4" />} tone="warning" text={error} />}
      <Metrics state={state} />
      {loading && <Notice tone="plain" text="Loading Symphony state..." />}
      {state.service.credentialStatus === "setup_required" && (
        <Notice tone="warning" text="Connect Linear in Matrix Integrations to let Symphony poll assigned work." />
      )}

      <section className="grid min-h-0 flex-1 gap-5 overflow-y-auto px-5 pb-5 lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)] lg:overflow-hidden">
        <RunGroups busy={busy} state={state} onSelectIssue={selectIssue} />
        <DetailPanel activeIssue={activeIssue} detail={detail} logLines={logLines} state={state} />
      </section>
    </main>
  );
}

function SymphonyHeader({
  activeIssue,
  busy,
  serviceControl,
  onRefresh,
  onStartService,
  onStopCurrent,
  onStopService,
}: {
  activeIssue: string | null;
  busy: string | null;
  serviceControl: SymphonyServiceControl;
  onRefresh: () => Promise<void>;
  onStartService: () => Promise<void>;
  onStopCurrent: () => Promise<void>;
  onStopService: () => Promise<void>;
}) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-3 border-b bg-white px-5 py-4">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-normal">Symphony</h1>
        <p className="truncate text-sm text-muted-foreground">Service: {serviceControl.status}</p>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" onClick={() => void onStartService()} disabled={!serviceControl.canStart || Boolean(busy)}>
          <Play className="size-4" /> Start
        </Button>
        <Button variant="outline" onClick={() => void onStopService()} disabled={!serviceControl.canStop || Boolean(busy)}>
          <Power className="size-4" /> Stop Service
        </Button>
        <Button variant="outline" onClick={() => void onRefresh()} disabled={Boolean(busy)}>
          <RefreshCw className="size-4" /> Refresh
        </Button>
        <Button variant="outline" onClick={() => void onStopCurrent()} disabled={!activeIssue || Boolean(busy)}>
          <Square className="size-4" /> Stop Run
        </Button>
      </div>
    </header>
  );
}

function Notice({ icon, text, tone: noticeTone }: { icon?: ReactNode; text: string; tone: "plain" | "warning" }) {
  const className = noticeTone === "warning"
    ? "mx-5 mt-4 flex items-center gap-2 border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
    : "mx-5 mb-4 border bg-white px-4 py-3 text-sm text-muted-foreground";
  return <div className={className}>{icon}{text}</div>;
}

function Metrics({ state }: { state: SymphonyState }) {
  return (
    <section className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-4">
      <Metric label="Queue" value={state.groups.queue.length} />
      <Metric label="Running" value={state.groups.running.length} />
      <Metric label="Needs Attention" value={state.groups.needsAttention.length} />
      <Metric label="Done / Handoff" value={state.groups.done.length} />
    </section>
  );
}

function RunGroups({ busy, state, onSelectIssue }: { busy: string | null; state: SymphonyState; onSelectIssue: (issueIdentifier: string | null | undefined) => void }) {
  return (
    <div className="min-h-0 space-y-4 lg:overflow-y-auto lg:pr-1">
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
                onClick={() => onSelectIssue(run.issueIdentifier)}
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
  );
}

function DetailPanel({ activeIssue, detail, logLines, state }: {
  activeIssue: string | null;
  detail: SymphonyIssueDetail | null;
  logLines: string[];
  state: SymphonyState;
}) {
  return (
    <aside className="min-h-0 overflow-y-auto border bg-white p-4">
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
