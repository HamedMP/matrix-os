import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, ExternalLink, KeyRound, Play, RefreshCw, Square, TerminalSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

type RunStatus = "queued" | "running" | "retrying" | "blocked" | "stopped" | "failed" | "handoff" | "completed";
type Agent = "codex" | "claude" | "opencode" | "pi";

interface SymphonyStatus {
  running: boolean;
  installationId: string | null;
  credentialConfigured: boolean;
  pollIntervalMs: number | null;
  maxConcurrentAgents: number | null;
  counts: { queued: number; running: number; needsAttention: number; handoff: number };
  lastPollAt: string | null;
}

interface SymphonyConfigResponse {
  installation: {
    projectSlug: string;
    enabled: boolean;
    credentialConfigured: boolean;
    pollIntervalMs: number;
    maxConcurrentAgents: number;
    defaultAgent: Agent;
    authorizedOperators: string[];
  } | null;
  rule: {
    teamId: string;
    teamKey: string;
    projectId?: string;
    projectSlug?: string;
    requiredLabels: string[];
    activeStates: string[];
    terminalStates: string[];
    assigneeIds: string[];
  } | null;
}

interface SetupOptions {
  credentialConfigured: boolean;
  matrixProjects: Array<{ slug: string; name: string; repositoryUrl?: string }>;
  linear: {
    teams: Array<{ id: string; key: string; name: string }>;
    projects: Array<{ id: string; name: string; slug?: string; teamIds: string[] }>;
    users: Array<{ id: string; name: string; displayName?: string; active?: boolean }>;
  };
}

interface Ticket {
  externalId: string;
  identifier: string;
  title: string;
  url?: string;
  stateName: string;
  assigneeName?: string;
  labels: string[];
}

interface Run {
  id: string;
  status: RunStatus;
  ticketIdentifier: string;
  ticketTitle: string;
  ticketUrl?: string;
  agent: Agent;
  projectSlug: string;
  worktreeId?: string;
  sessionId?: string;
  lastEvent: string;
  updatedAt: string;
}

interface FormState {
  projectSlug: string;
  teamId: string;
  teamKey: string;
  linearProjectId: string;
  linearProjectSlug: string;
  linearSecret: string;
  requiredLabels: string;
  activeStates: string;
  terminalStates: string;
  assigneeIds: string[];
  maxConcurrentAgents: number;
  defaultAgent: Agent;
}

interface LoadOptions {
  hydrateForm?: boolean;
}

interface MatrixOSBridge {
  openApp?: (name: string, path: string) => void;
}

declare global {
  interface Window {
    MatrixOS?: MatrixOSBridge;
  }
}

const DEFAULT_FORM: FormState = {
  projectSlug: "matrix-os",
  teamId: "",
  teamKey: "MAT",
  linearProjectId: "",
  linearProjectSlug: "",
  linearSecret: "",
  requiredLabels: "symphony",
  activeStates: "Todo, In Progress",
  terminalStates: "Done, Canceled, Cancelled, Duplicate",
  assigneeIds: [],
  maxConcurrentAgents: 3,
  defaultAgent: "codex",
};

function splitList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!response.ok) throw new Error("request_failed");
  return await response.json() as T;
}

function groupRuns(runs: Run[]) {
  return {
    Queue: runs.filter((run) => run.status === "queued"),
    Running: runs.filter((run) => run.status === "running"),
    "Needs Attention": runs.filter((run) => ["retrying", "blocked", "failed"].includes(run.status)),
    "Done / Handoff": runs.filter((run) => ["handoff", "completed", "stopped"].includes(run.status)),
  };
}

function statusTone(status: RunStatus): string {
  if (status === "running") return "bg-emerald-100 text-emerald-800";
  if (status === "queued") return "bg-sky-100 text-sky-800";
  if (["retrying", "blocked", "failed"].includes(status)) return "bg-amber-100 text-amber-900";
  return "bg-zinc-100 text-zinc-700";
}

function openWorkspaceInShell() {
  if (window.MatrixOS?.openApp) {
    window.MatrixOS.openApp("Workspace", "__workspace__");
    return;
  }

  window.parent.postMessage({
    type: "os:open-app",
    app: "Symphony",
    payload: { name: "Workspace", path: "__workspace__" },
  }, "*");
}

export default function App() {
  const [status, setStatus] = useState<SymphonyStatus | null>(null);
  const [config, setConfig] = useState<SymphonyConfigResponse | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [setupOptions, setSetupOptions] = useState<SetupOptions | null>(null);
  const [setupLoading, setSetupLoading] = useState(false);
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsOpenRef = useRef(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    settingsOpenRef.current = settingsOpen;
  }, [settingsOpen]);

  const load = useCallback(async (options: LoadOptions = {}) => {
    setError(null);
    const [nextStatus, nextConfig, runList] = await Promise.all([
      fetchJson<SymphonyStatus>("/api/symphony/status"),
      fetchJson<SymphonyConfigResponse>("/api/symphony/config"),
      fetchJson<{ runs: Run[] }>("/api/symphony/runs"),
    ]);
    setStatus(nextStatus);
    setConfig(nextConfig);
    setRuns(runList.runs);
    if ((options.hydrateForm ?? true) && !settingsOpenRef.current && (nextConfig.installation || nextConfig.rule)) {
      setForm({
        projectSlug: nextConfig.installation?.projectSlug ?? DEFAULT_FORM.projectSlug,
        teamId: nextConfig.rule?.teamId ?? "",
        teamKey: nextConfig.rule?.teamKey ?? DEFAULT_FORM.teamKey,
        linearProjectId: nextConfig.rule?.projectId ?? "",
        linearProjectSlug: nextConfig.rule?.projectSlug ?? "",
        linearSecret: "",
        requiredLabels: nextConfig.rule?.requiredLabels.join(", ") ?? DEFAULT_FORM.requiredLabels,
        activeStates: nextConfig.rule?.activeStates.join(", ") ?? DEFAULT_FORM.activeStates,
        terminalStates: nextConfig.rule?.terminalStates.join(", ") ?? DEFAULT_FORM.terminalStates,
        assigneeIds: nextConfig.rule?.assigneeIds ?? [],
        maxConcurrentAgents: nextConfig.installation?.maxConcurrentAgents ?? DEFAULT_FORM.maxConcurrentAgents,
        defaultAgent: nextConfig.installation?.defaultAgent ?? DEFAULT_FORM.defaultAgent,
      });
    }
  }, []);

  useEffect(() => {
    void load().catch((err: unknown) => {
      console.warn("[symphony] initial load failed:", err instanceof Error ? err.message : String(err));
      setError("Symphony could not load.");
    });
  }, [load]);

  useEffect(() => {
    if (typeof EventSource === "undefined") return undefined;
    let closed = false;
    const events = new EventSource("/api/symphony/events");
    const refresh = () => {
      if (closed) return;
      void load({ hydrateForm: false }).catch((err: unknown) => {
        console.warn("[symphony] event refresh failed:", err instanceof Error ? err.message : String(err));
      });
    };
    const eventTypes = [
      "symphony.config.updated",
      "symphony.credential.updated",
      "symphony.credential.deleted",
      "symphony.started",
      "symphony.stopped",
      "symphony.poll.completed",
      "symphony.run.updated",
      "symphony.run.stopped",
      "symphony.run.retry",
    ];
    for (const type of eventTypes) events.addEventListener(type, refresh);
    events.onerror = () => {
      if (!closed) console.warn("[symphony] event stream interrupted");
    };
    return () => {
      closed = true;
      for (const type of eventTypes) events.removeEventListener(type, refresh);
      events.close();
    };
  }, [load]);

  const grouped = useMemo(() => groupRuns(runs), [runs]);
  const filteredLinearProjects = useMemo(() => {
    const projects = setupOptions?.linear.projects ?? [];
    if (!form.teamId) return projects;
    return projects.filter((project) => project.teamIds.length === 0 || project.teamIds.includes(form.teamId));
  }, [form.teamId, setupOptions?.linear.projects]);
  const needsSetup = !status?.credentialConfigured || !config?.rule;

  const loadSetupOptions = useCallback(async () => {
    setSetupLoading(true);
    setError(null);
    try {
      const options = await fetchJson<SetupOptions>("/api/symphony/setup-options");
      setSetupOptions(options);
      setForm((current) => ({
        ...current,
        projectSlug: current.projectSlug || options.matrixProjects[0]?.slug || DEFAULT_FORM.projectSlug,
      }));
    } catch (err: unknown) {
      console.warn("[symphony] setup options failed:", err instanceof Error ? err.message : String(err));
      setError("Symphony setup options could not be loaded.");
    } finally {
      setSetupLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!settingsOpen) return;
    void loadSetupOptions();
  }, [loadSetupOptions, settingsOpen]);

  function selectLinearTeam(teamId: string) {
    const team = setupOptions?.linear.teams.find((candidate) => candidate.id === teamId);
    setForm((current) => ({
      ...current,
      teamId,
      teamKey: team?.key ?? "",
      linearProjectId: "",
      linearProjectSlug: "",
    }));
  }

  function selectLinearProject(projectId: string) {
    const project = setupOptions?.linear.projects.find((candidate) => candidate.id === projectId);
    setForm((current) => ({
      ...current,
      linearProjectId: projectId,
      linearProjectSlug: project?.slug ?? "",
    }));
  }

  function toggleAssignee(userId: string) {
    setForm((current) => ({
      ...current,
      assigneeIds: current.assigneeIds.includes(userId)
        ? current.assigneeIds.filter((id) => id !== userId)
        : [...current.assigneeIds, userId],
    }));
  }

  function resetLinearSelection(next: Partial<FormState> = {}) {
    setForm((current) => ({
      ...current,
      teamId: "",
      teamKey: "",
      linearProjectId: "",
      linearProjectSlug: "",
      assigneeIds: [],
      ...next,
    }));
  }

  async function saveLinearCredential() {
    if (!form.linearSecret.trim()) return;
    setBusy("credential");
    setError(null);
    try {
      await fetchJson("/api/symphony/credentials/linear", {
        method: "POST",
        body: JSON.stringify({ kind: "api_key", secret: form.linearSecret.trim() }),
      });
      resetLinearSelection({ linearSecret: "" });
      await loadSetupOptions();
      await load({ hydrateForm: false });
    } catch (err: unknown) {
      console.warn("[symphony] credential save failed:", err instanceof Error ? err.message : String(err));
      setError("Linear credential could not be saved.");
    } finally {
      setBusy(null);
    }
  }

  async function saveSetup() {
    setBusy("setup");
    setError(null);
    try {
      if (form.linearSecret.trim()) {
        await fetchJson("/api/symphony/credentials/linear", {
          method: "POST",
          body: JSON.stringify({ kind: "api_key", secret: form.linearSecret.trim() }),
        });
        resetLinearSelection({ linearSecret: "" });
        await loadSetupOptions();
        return;
      }
      await fetchJson("/api/symphony/config", {
        method: "POST",
        body: JSON.stringify({
          installation: {
            projectSlug: form.projectSlug,
            pollIntervalMs: config?.installation?.pollIntervalMs ?? 30_000,
            maxConcurrentAgents: Number(form.maxConcurrentAgents),
            defaultAgent: form.defaultAgent,
            authorizedOperators: config?.installation?.authorizedOperators ?? [],
          },
          rule: {
            teamId: form.teamId,
            teamKey: form.teamKey,
            projectId: form.linearProjectId || undefined,
            projectSlug: form.linearProjectSlug || undefined,
            requiredLabels: splitList(form.requiredLabels),
            activeStates: splitList(form.activeStates),
            terminalStates: splitList(form.terminalStates),
            assigneeIds: form.assigneeIds,
          },
        }),
      });
      const preview = await fetchJson<{ tickets: Ticket[] }>("/api/symphony/tickets/preview?limit=10");
      setTickets(preview.tickets);
      setSettingsOpen(false);
      await load();
    } catch (err: unknown) {
      console.warn("[symphony] setup save failed:", err instanceof Error ? err.message : String(err));
      setError("Symphony setup could not be saved.");
    } finally {
      setBusy(null);
    }
  }

  async function startStop() {
    setBusy("toggle");
    setError(null);
    try {
      await fetchJson(status?.running ? "/api/symphony/stop" : "/api/symphony/start", {
        method: "POST",
        body: JSON.stringify({}),
      });
      await load();
    } catch (err: unknown) {
      console.warn("[symphony] runtime toggle failed:", err instanceof Error ? err.message : String(err));
      setError(status?.running ? "Symphony could not be stopped." : "Symphony could not be started.");
    } finally {
      setBusy(null);
    }
  }

  async function runAction(run: Run, type: "stop" | "retry" | "open_workspace") {
    if (type === "open_workspace") {
      openWorkspaceInShell();
      return;
    }
    setBusy(`${type}:${run.id}`);
    setError(null);
    try {
      await fetchJson(`/api/symphony/runs/${run.id}/actions`, {
        method: "POST",
        body: JSON.stringify({ type }),
      });
      await load();
    } catch (err: unknown) {
      console.warn("[symphony] run action failed:", err instanceof Error ? err.message : String(err));
      setError("Run action failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="flex items-center justify-between border-b bg-white/90 px-6 py-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal">Symphony</h1>
          <p className="text-sm text-muted-foreground">Matrix-native Linear agents and worktrees</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => void load()} disabled={Boolean(busy)} aria-label="Refresh Symphony">
            <RefreshCw className="size-4" />
          </Button>
          <Button variant="outline" onClick={() => setSettingsOpen((open) => !open)}>
            <KeyRound className="size-4" /> Setup
          </Button>
          <Button onClick={() => void startStop()} disabled={Boolean(busy) || needsSetup}>
            {status?.running ? <Square className="size-4" /> : <Play className="size-4" />}
            {status?.running ? "Stop" : "Start"}
          </Button>
        </div>
      </header>

      {error && (
        <div className="mx-6 mt-4 flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <AlertTriangle className="size-4" /> {error}
        </div>
      )}

      <section className="grid gap-4 p-6 md:grid-cols-4">
        <Metric label="Queue" value={status?.counts.queued ?? 0} />
        <Metric label="Running" value={status?.counts.running ?? 0} />
        <Metric label="Needs Attention" value={status?.counts.needsAttention ?? 0} />
        <Metric label="Done / Handoff" value={status?.counts.handoff ?? 0} />
      </section>

      <section className="grid gap-6 px-6 pb-6 lg:grid-cols-[1fr_360px]">
        <div className="space-y-5">
          {Object.entries(grouped).map(([label, group]) => (
            <section key={label} className="rounded-md border bg-white">
              <div className="flex items-center justify-between border-b px-4 py-3">
                <h2 className="text-sm font-semibold uppercase tracking-normal text-muted-foreground">{label}</h2>
                <span className="text-sm text-muted-foreground">{group.length}</span>
              </div>
              <div className="divide-y">
                {group.length === 0 ? (
                  <div className="flex items-center gap-3 px-4 py-8 text-sm text-muted-foreground">
                    <TerminalSquare className="size-5" />
                    No runs in this group.
                  </div>
                ) : group.map((run) => (
                  <RunRow key={run.id} run={run} busy={busy} onAction={(type) => void runAction(run, type)} />
                ))}
              </div>
            </section>
          ))}
        </div>

        <aside className="rounded-md border bg-white p-4">
          <h2 className="text-base font-semibold">Setup</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {needsSetup ? "Connect Linear and choose which assigned tickets Symphony can claim." : "Linear and ticket rules are configured."}
          </p>
          <div className="mt-4 space-y-2 text-sm">
            <StatusLine label="Linear credential" value={status?.credentialConfigured ? "Configured" : "Missing"} />
            <StatusLine label="Project" value={config?.installation?.projectSlug ?? "Not set"} />
            <StatusLine label="Team" value={config?.rule?.teamKey ?? "Not set"} />
            <StatusLine label="Assignees" value={config?.rule?.assigneeIds.length ? `${config.rule.assigneeIds.length} selected` : "Any matching assignee"} />
          </div>
          {tickets.length > 0 && (
            <div className="mt-4 border-t pt-4">
              <h3 className="text-sm font-semibold">Preview</h3>
              <div className="mt-2 space-y-2">
                {tickets.slice(0, 4).map((ticket) => (
                  <div key={ticket.externalId} className="rounded-md bg-zinc-50 p-2 text-sm">
                    <div className="font-medium">{ticket.identifier}</div>
                    <div className="text-muted-foreground">{ticket.title}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </aside>
      </section>

      {settingsOpen && (
        <div className="fixed inset-0 z-20 bg-black/20" onClick={() => setSettingsOpen(false)}>
          <section className="absolute right-0 top-0 h-full w-full max-w-[420px] overflow-auto bg-white p-5 shadow-xl" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Symphony Setup</h2>
              <Button variant="ghost" onClick={() => setSettingsOpen(false)}>Close</Button>
            </div>
            <div className="mt-5 space-y-4">
              <div className="rounded-md border bg-zinc-50 p-3">
                <Field label="Linear API key"><Input value={form.linearSecret} type="password" onChange={(event) => setForm({ ...form, linearSecret: event.target.value })} placeholder="lin_api_..." /></Field>
                <Button className="mt-3 w-full" variant="outline" onClick={() => void saveLinearCredential()} disabled={busy === "credential" || !form.linearSecret.trim()}>
                  Save Linear Key
                </Button>
              </div>
              <Field label="Matrix project">
                <select
                  className="h-10 w-full rounded-md border bg-white px-3 text-sm"
                  value={form.projectSlug}
                  onChange={(event) => setForm({ ...form, projectSlug: event.target.value })}
                >
                  {(setupOptions?.matrixProjects.length ? setupOptions.matrixProjects : [{ slug: form.projectSlug, name: form.projectSlug }]).map((project) => (
                    <option key={project.slug} value={project.slug}>{project.name} ({project.slug})</option>
                  ))}
                </select>
              </Field>
              <Field label="Linear team">
                <select
                  className="h-10 w-full rounded-md border bg-white px-3 text-sm"
                  value={form.teamId}
                  onChange={(event) => selectLinearTeam(event.target.value)}
                  disabled={setupLoading || !setupOptions?.linear.teams.length}
                >
                  <option value="">{setupLoading ? "Loading Linear teams..." : "Choose a Linear team"}</option>
                  {(setupOptions?.linear.teams ?? []).map((team) => (
                    <option key={team.id} value={team.id}>{team.name} ({team.key})</option>
                  ))}
                </select>
              </Field>
              <Field label="Linear project">
                <select
                  className="h-10 w-full rounded-md border bg-white px-3 text-sm"
                  value={form.linearProjectId}
                  onChange={(event) => selectLinearProject(event.target.value)}
                  disabled={setupLoading || filteredLinearProjects.length === 0}
                >
                  <option value="">Any project in selected team</option>
                  {filteredLinearProjects.map((project) => (
                    <option key={project.id} value={project.id}>{project.name}{project.slug ? ` (${project.slug})` : ""}</option>
                  ))}
                </select>
              </Field>
              <div className="block text-sm">
                <div className="mb-2 font-medium">Team members</div>
                <div className="max-h-44 space-y-2 overflow-auto rounded-md border bg-white p-2">
                  {(setupOptions?.linear.users ?? []).length === 0 ? (
                    <div className="px-1 py-2 text-muted-foreground">{setupLoading ? "Loading members..." : "Any matching assignee"}</div>
                  ) : setupOptions!.linear.users.filter((user) => user.active !== false).map((user) => (
                    <label key={user.id} className="flex items-center gap-2 rounded px-1 py-1">
                      <input type="checkbox" checked={form.assigneeIds.includes(user.id)} onChange={() => toggleAssignee(user.id)} />
                      <span className="min-w-0 flex-1 truncate">{user.displayName ?? user.name}</span>
                    </label>
                  ))}
                </div>
              </div>
              <Field label="Required labels"><Input value={form.requiredLabels} onChange={(event) => setForm({ ...form, requiredLabels: event.target.value })} /></Field>
              <Field label="Active states"><Input value={form.activeStates} onChange={(event) => setForm({ ...form, activeStates: event.target.value })} /></Field>
              <Field label="Terminal states"><Input value={form.terminalStates} onChange={(event) => setForm({ ...form, terminalStates: event.target.value })} /></Field>
              <Field label="Concurrency"><Input value={form.maxConcurrentAgents} type="number" min={1} max={10} onChange={(event) => setForm({ ...form, maxConcurrentAgents: Number(event.target.value) })} /></Field>
              <Button className="w-full" onClick={() => void saveSetup()} disabled={busy === "setup" || !form.teamId.trim()}>
                Save and Preview Tickets
              </Button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border bg-white px-4 py-3">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
    </div>
  );
}

function StatusLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium">{label}</span>
      {children}
    </label>
  );
}

function RunRow({ run, busy, onAction }: { run: Run; busy: string | null; onAction: (type: "stop" | "retry" | "open_workspace") => void }) {
  return (
    <div className="grid gap-3 px-4 py-3 md:grid-cols-[1fr_auto] md:items-center">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">{run.ticketIdentifier}</span>
          <Badge className={statusTone(run.status)}>{run.status}</Badge>
          <span className="text-sm text-muted-foreground">{run.agent}</span>
        </div>
        <div className="mt-1 text-sm">{run.ticketTitle}</div>
        <div className="mt-1 text-xs text-muted-foreground">{run.lastEvent}</div>
      </div>
      <div className="flex items-center gap-2">
        {run.ticketUrl && (
          <Button variant="outline" size="sm" onClick={() => window.open(run.ticketUrl, "_blank", "noopener,noreferrer")}>
            <ExternalLink className="size-4" /> Ticket
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={() => onAction("open_workspace")}>Workspace</Button>
        {run.status === "running" ? (
          <Button variant="outline" size="sm" disabled={busy === `stop:${run.id}`} onClick={() => onAction("stop")}>Stop</Button>
        ) : (
          <Button variant="outline" size="sm" disabled={busy === `retry:${run.id}`} onClick={() => onAction("retry")}>Retry</Button>
        )}
      </div>
    </div>
  );
}
