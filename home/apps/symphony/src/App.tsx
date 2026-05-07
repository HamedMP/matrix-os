import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Bot,
  CheckCircle2,
  CircleAlert,
  Code2,
  ExternalLink,
  GitBranch,
  Github,
  Layers3,
  ListChecks,
  Play,
  Plus,
  RefreshCw,
  Send,
  Settings2,
  Ticket,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import "./index.css";

const APP_ID = "symphony";
const CONFIG_KEY = "config";
const FETCH_TIMEOUT_MS = 10_000;
const SYMPHONY_STATES = [
  { name: "Rework", color: "#db6e1f" },
  { name: "Human Review", color: "#da8b0d" },
  { name: "Merging", color: "#0f783c" },
];

type Connection = {
  id: string;
  service: string;
  account_label: string;
  account_email?: string | null;
  status: string;
};

type Team = { id: string; key: string; name: string };
type Project = { id: string; name: string; slugId?: string; state?: string; teams?: { nodes?: Team[] } };
type WorkflowState = { id: string; name: string; type: string; color?: string; team?: Team };
type Issue = {
  id: string;
  identifier: string;
  title: string;
  url: string;
  updatedAt?: string;
  state?: { id: string; name: string; color?: string };
  project?: { id: string; name: string; slugId?: string };
};

type SymphonyConfig = {
  repoUrl: string;
  cloneUrl: string;
  githubRepo: string;
  workflowPath: string;
  projectSlug: string;
  teamId: string;
  projectId: string;
  dashboardUrl: string;
};

const DEFAULT_CONFIG: SymphonyConfig = {
  repoUrl: "https://github.com/HamedMP/matrix-os",
  cloneUrl: "https://github.com/HamedMP/matrix-os.git",
  githubRepo: "HamedMP/matrix-os",
  workflowPath: "/home/deploy/matrix-os/WORKFLOW.md",
  projectSlug: "",
  teamId: "",
  projectId: "",
  dashboardUrl: "http://127.0.0.1:4001",
};

async function readConfig(): Promise<SymphonyConfig> {
  const params = new URLSearchParams({ app: APP_ID, key: CONFIG_KEY });
  const response = await fetch(`/api/bridge/data?${params.toString()}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) return DEFAULT_CONFIG;
  const payload = (await response.json()) as { value?: string | null };
  if (!payload.value) return DEFAULT_CONFIG;
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(payload.value) };
  } catch (err: unknown) {
    console.warn("[symphony] ignored invalid config:", err instanceof Error ? err.message : String(err));
    return DEFAULT_CONFIG;
  }
}

async function writeConfig(config: SymphonyConfig): Promise<void> {
  const response = await fetch("/api/bridge/data", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    body: JSON.stringify({
      action: "write",
      app: APP_ID,
      key: CONFIG_KEY,
      value: JSON.stringify(config),
    }),
  });
  if (!response.ok) throw new Error("config_write_failed");
}

async function fetchConnections(): Promise<Connection[]> {
  const response = await fetch("/api/integrations", {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) return [];
  return (await response.json()) as Connection[];
}

async function connectService(service: "linear" | "github"): Promise<void> {
  const response = await fetch("/api/integrations/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    body: JSON.stringify({ service, label: service === "linear" ? "Linear" : "GitHub" }),
  });
  if (!response.ok) throw new Error("connect_failed");
  const payload = (await response.json()) as { url?: string };
  if (payload.url) window.open(payload.url, "_blank", "noopener,noreferrer");
}

async function callService<T>(service: "linear" | "github", action: string, params?: Record<string, unknown>): Promise<T> {
  const response = await fetch("/api/integrations/call", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    body: JSON.stringify({ service, action, params }),
  });
  if (!response.ok) throw new Error("integration_call_failed");
  const payload = (await response.json()) as { data?: unknown };
  return payload.data as T;
}

function graphData<T extends object>(payload: unknown): T {
  if (!payload || typeof payload !== "object") return {} as T;
  const value = payload as { data?: unknown };
  if (value.data && typeof value.data === "object") return value.data as T;
  return payload as T;
}

function connectionFor(connections: Connection[], service: string): Connection | undefined {
  return connections.find((connection) => connection.service === service && connection.status !== "revoked");
}

function stateBadgeVariant(stateName: string | undefined): "secondary" | "success" | "warning" | "outline" {
  if (!stateName) return "outline";
  if (stateName === "Human Review" || stateName === "Merging") return "success";
  if (stateName === "Rework") return "warning";
  return "secondary";
}

function App() {
  const [config, setConfig] = useState<SymphonyConfig>(DEFAULT_CONFIG);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [states, setStates] = useState<WorkflowState[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [selectedState, setSelectedState] = useState("Todo");
  const [newIssueTitle, setNewIssueTitle] = useState("");
  const [newIssueDescription, setNewIssueDescription] = useState("");
  const [graphqlQuery, setGraphqlQuery] = useState("query MatrixLinearViewer { viewer { id name email } }");
  const [graphqlResult, setGraphqlResult] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const linearConnection = useMemo(() => connectionFor(connections, "linear"), [connections]);
  const githubConnection = useMemo(() => connectionFor(connections, "github"), [connections]);
  const selectedProject = projects.find((project) => project.id === config.projectId);
  const missingSymphonyStates = SYMPHONY_STATES.filter(
    (required) => !states.some((state) => state.name.toLowerCase() === required.name.toLowerCase()),
  );

  const saveConfig = useCallback(async (next: SymphonyConfig) => {
    setConfig(next);
    await writeConfig(next);
  }, []);

  const updateConfig = useCallback((patch: Partial<SymphonyConfig>) => {
    setConfig((current) => ({ ...current, ...patch }));
  }, []);

  const persistConfig = useCallback(async () => {
    try {
      await writeConfig(config);
    } catch (err: unknown) {
      console.warn("[symphony] config save failed:", err instanceof Error ? err.message : String(err));
      setError("Symphony settings could not be saved.");
    }
  }, [config]);

  const refreshConnections = useCallback(async () => {
    const next = await fetchConnections();
    setConnections(next);
  }, []);

  const refreshLinear = useCallback(async (baseConfig = config) => {
    if (!linearConnection) return;
    setBusy("Refreshing Linear");
    setError(null);
    try {
      const [teamPayload, projectPayload] = await Promise.all([
        callService<unknown>("linear", "list_teams", { first: 100 }),
        callService<unknown>("linear", "list_projects", { first: 100 }),
      ]);
      const nextTeams = graphData<{ teams?: { nodes?: Team[] } }>(teamPayload).teams?.nodes ?? [];
      const nextProjects = graphData<{ projects?: { nodes?: Project[] } }>(projectPayload).projects?.nodes ?? [];
      const teamId = baseConfig.teamId || nextTeams[0]?.id || "";
      const projectId = baseConfig.projectId || nextProjects[0]?.id || "";
      const nextConfig = { ...baseConfig, teamId, projectId };
      setTeams(nextTeams);
      setProjects(nextProjects);
      setConfig(nextConfig);
      if (teamId) {
        const [statePayload, issuePayload] = await Promise.all([
          callService<unknown>("linear", "list_workflow_states", { teamId, first: 100 }),
          callService<unknown>("linear", "list_issues", {
            teamId,
            projectId: projectId || undefined,
            state: selectedState || undefined,
            first: 50,
          }),
        ]);
        setStates(graphData<{ workflowStates?: { nodes?: WorkflowState[] } }>(statePayload).workflowStates?.nodes ?? []);
        setIssues(graphData<{ issues?: { nodes?: Issue[] } }>(issuePayload).issues?.nodes ?? []);
      }
    } catch (err: unknown) {
      console.warn("[symphony] Linear refresh failed:", err instanceof Error ? err.message : String(err));
      setError("Linear data could not be loaded.");
    } finally {
      setBusy(null);
    }
  }, [config, linearConnection, selectedState]);

  useEffect(() => {
    Promise.all([readConfig(), fetchConnections()])
      .then(([storedConfig, storedConnections]) => {
        setConfig(storedConfig);
        setConnections(storedConnections);
      })
      .catch((err: unknown) => {
        console.warn("[symphony] startup failed:", err instanceof Error ? err.message : String(err));
        setError("Symphony could not load saved settings.");
      });
  }, []);

  useEffect(() => {
    if (linearConnection) void refreshLinear(config);
  }, [linearConnection?.id, selectedState]);

  const runConnect = useCallback(async (service: "linear" | "github") => {
    setBusy(`Connecting ${service}`);
    setError(null);
    try {
      await connectService(service);
      await refreshConnections();
    } catch (err: unknown) {
      console.warn("[symphony] connect failed:", err instanceof Error ? err.message : String(err));
      setError(`${service === "linear" ? "Linear" : "GitHub"} connection could not be started.`);
    } finally {
      setBusy(null);
    }
  }, [refreshConnections]);

  const createSymphonyStates = useCallback(async () => {
    if (!config.teamId) return;
    setBusy("Creating workflow states");
    setError(null);
    try {
      for (const state of missingSymphonyStates) {
        await callService("linear", "create_workflow_state", {
          teamId: config.teamId,
          name: state.name,
          color: state.color,
          type: "started",
        });
      }
      await refreshLinear();
    } catch (err: unknown) {
      console.warn("[symphony] state creation failed:", err instanceof Error ? err.message : String(err));
      setError("Workflow states could not be created.");
    } finally {
      setBusy(null);
    }
  }, [config.teamId, missingSymphonyStates, refreshLinear]);

  const createIssue = useCallback(async () => {
    if (!config.teamId || !newIssueTitle.trim()) return;
    setBusy("Creating issue");
    setError(null);
    try {
      await callService("linear", "create_issue", {
        teamId: config.teamId,
        projectId: config.projectId || undefined,
        title: newIssueTitle.trim(),
        description: newIssueDescription.trim() || undefined,
      });
      setNewIssueTitle("");
      setNewIssueDescription("");
      await refreshLinear();
    } catch (err: unknown) {
      console.warn("[symphony] issue creation failed:", err instanceof Error ? err.message : String(err));
      setError("Issue could not be created.");
    } finally {
      setBusy(null);
    }
  }, [config.projectId, config.teamId, newIssueDescription, newIssueTitle, refreshLinear]);

  const runGraphql = useCallback(async () => {
    if (!graphqlQuery.trim()) return;
    setBusy("Running GraphQL");
    setError(null);
    try {
      const result = await callService("linear", "graphql", { query: graphqlQuery });
      setGraphqlResult(JSON.stringify(result, null, 2));
    } catch (err: unknown) {
      console.warn("[symphony] graphql failed:", err instanceof Error ? err.message : String(err));
      setError("GraphQL operation failed.");
    } finally {
      setBusy(null);
    }
  }, [graphqlQuery]);

  const command = [
    "set -a",
    "source .env",
    "set +a",
    "cd /home/deploy/symphony/elixir",
    `mise exec -- ./bin/symphony ${config.workflowPath} --port 4001 --i-understand-that-this-will-be-running-without-the-usual-guardrails`,
  ].join(" && ");

  return (
    <main className="h-screen overflow-auto bg-background p-4 text-foreground sm:p-5">
      <section className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-slate-950 text-white">
            <Bot className="size-6" />
          </div>
          <div className="min-w-0">
            <div className="text-xs font-bold uppercase text-muted-foreground">Codex orchestration</div>
            <h1 className="text-2xl font-semibold leading-tight tracking-normal">Symphony</h1>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => refreshConnections()} disabled={Boolean(busy)}>
            <RefreshCw />Refresh
          </Button>
          <Button onClick={() => window.open(config.dashboardUrl, "_blank", "noopener,noreferrer")}>
            <Play />Dashboard
          </Button>
        </div>
      </section>

      {error ? (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm font-semibold text-destructive">
          <CircleAlert className="size-4" />{error}
        </div>
      ) : null}
      {busy ? (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-primary/25 bg-primary/10 px-3 py-2 text-sm font-semibold text-primary">
          <RefreshCw className="size-4 animate-spin" />{busy}
        </div>
      ) : null}

      <section className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatusCard icon={<Ticket />} label="Linear" value={linearConnection?.account_label ?? "Not connected"} ok={Boolean(linearConnection)} onClick={() => runConnect("linear")} />
        <StatusCard icon={<Github />} label="GitHub" value={githubConnection?.account_label ?? "Not connected"} ok={Boolean(githubConnection)} onClick={() => runConnect("github")} />
        <StatusCard icon={<Layers3 />} label="Project" value={selectedProject?.slugId || config.projectSlug || "Unset"} ok={Boolean(config.projectId || config.projectSlug)} />
        <StatusCard icon={<ListChecks />} label="Workflow states" value={missingSymphonyStates.length === 0 ? "Ready" : `${missingSymphonyStates.length} missing`} ok={missingSymphonyStates.length === 0} />
      </section>

      <section className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(360px,0.9fr)_minmax(460px,1.15fr)]">
        <Card>
          <CardHeader>
            <div>
              <CardTitle className="flex items-center gap-2"><Settings2 className="size-4" />Setup</CardTitle>
              <CardDescription>Connect Linear and GitHub, then bind this repo to a Symphony project.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <Field label="GitHub repo">
                <Input value={config.githubRepo} onChange={(event) => updateConfig({ githubRepo: event.target.value })} onBlur={persistConfig} />
              </Field>
              <Field label="Clone URL">
                <Input value={config.cloneUrl} onChange={(event) => updateConfig({ cloneUrl: event.target.value })} onBlur={persistConfig} />
              </Field>
              <Field label="Workflow path">
                <Input value={config.workflowPath} onChange={(event) => updateConfig({ workflowPath: event.target.value })} onBlur={persistConfig} />
              </Field>
              <Field label="Project slug">
                <Input value={config.projectSlug} onChange={(event) => updateConfig({ projectSlug: event.target.value })} onBlur={persistConfig} placeholder="Linear slugId" />
              </Field>
              <Field label="Team">
                <Select value={config.teamId} onChange={(event) => saveConfig({ ...config, teamId: event.target.value })}>
                  <option value="">Select team</option>
                  {teams.map((team) => <option key={team.id} value={team.id}>{team.key} - {team.name}</option>)}
                </Select>
              </Field>
              <Field label="Project">
                <Select value={config.projectId} onChange={(event) => saveConfig({ ...config, projectId: event.target.value, projectSlug: projects.find((project) => project.id === event.target.value)?.slugId ?? config.projectSlug })}>
                  <option value="">No project filter</option>
                  {projects.map((project) => <option key={project.id} value={project.id}>{project.slugId ?? project.name}</option>)}
                </Select>
              </Field>
            </div>

            <div className="overflow-hidden rounded-lg border bg-slate-950 text-slate-100">
              <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2 text-xs font-bold text-slate-400">
                <Code2 className="size-4" />Runtime command
              </div>
              <code className="block overflow-x-auto whitespace-pre-wrap p-3 text-xs leading-relaxed">{command}</code>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => refreshLinear()} disabled={!linearConnection || Boolean(busy)}>
                <RefreshCw />Sync Linear
              </Button>
              <Button onClick={createSymphonyStates} disabled={!config.teamId || missingSymphonyStates.length === 0 || Boolean(busy)}>
                <Plus />Create states
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-col sm:flex-row sm:items-center">
            <div>
              <CardTitle className="flex items-center gap-2"><GitBranch className="size-4" />Linear Board</CardTitle>
              <CardDescription>Tickets in active Symphony states are what workers will claim.</CardDescription>
            </div>
            <Tabs>
              <TabsList>
                {["Todo", "In Progress", "Rework", "Human Review", "Merging", "Done"].map((state) => (
                  <TabsTrigger key={state} active={selectedState === state} onClick={() => setSelectedState(state)}>
                    {state}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2 overflow-x-auto pb-1">
              {states.map((state) => (
                <Badge variant={stateBadgeVariant(state.name)} key={state.id}>
                  <span className="size-2 rounded-full" style={{ background: state.color ?? "currentColor" }} />
                  {state.name}
                </Badge>
              ))}
            </div>

            <form className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto]" onSubmit={(event) => { event.preventDefault(); void createIssue(); }}>
              <Input value={newIssueTitle} onChange={(event) => setNewIssueTitle(event.target.value)} placeholder="New Linear ticket" />
              <Button type="submit" disabled={!config.teamId || !newIssueTitle.trim() || Boolean(busy)}>
                <Send />Create
              </Button>
              <Textarea className="sm:col-span-2" value={newIssueDescription} onChange={(event) => setNewIssueDescription(event.target.value)} placeholder="Acceptance criteria" />
            </form>

            <div className="flex max-h-[430px] flex-col gap-2 overflow-y-auto pr-1">
              {issues.map((issue) => (
                <a className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 rounded-lg border bg-background p-3 text-inherit no-underline transition-colors hover:bg-accent" href={issue.url} target="_blank" rel="noreferrer" key={issue.id}>
                  <Badge variant="outline">{issue.identifier}</Badge>
                  <strong className="truncate text-sm">{issue.title}</strong>
                  <ExternalLink className="size-4 text-muted-foreground" />
                  <span className="col-span-3 text-xs text-muted-foreground">
                    {issue.state?.name ?? "No state"}{issue.project ? ` · ${issue.project.name}` : ""}
                  </span>
                </a>
              ))}
              {issues.length === 0 ? <div className="flex min-h-36 items-center justify-center rounded-lg border border-dashed text-sm font-semibold text-muted-foreground">No tickets in this view.</div> : null}
            </div>
          </CardContent>
        </Card>

        <Card className="xl:col-span-2">
          <CardHeader>
            <div>
              <CardTitle className="flex items-center gap-2"><Code2 className="size-4" />Linear GraphQL</CardTitle>
              <CardDescription>Advanced Linear operations through the connected account.</CardDescription>
            </div>
            <Button variant="outline" onClick={runGraphql} disabled={!linearConnection || Boolean(busy)}>
              <Play />Run
            </Button>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <Textarea className="min-h-44 font-mono text-xs" value={graphqlQuery} onChange={(event) => setGraphqlQuery(event.target.value)} spellCheck={false} />
            <pre className="min-h-44 max-h-80 overflow-auto rounded-lg bg-slate-950 p-3 text-xs leading-relaxed text-blue-100">{graphqlResult || "{}"}</pre>
          </CardContent>
        </Card>
      </section>
    </main>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid gap-1.5">
      <span className="text-xs font-semibold text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function StatusCard({
  icon,
  label,
  value,
  ok,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  ok: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      className="grid min-h-[76px] grid-cols-[42px_minmax(0,1fr)_18px] items-center gap-3 rounded-lg border bg-card p-3 text-left transition-colors disabled:cursor-default"
      type="button"
      onClick={onClick}
      disabled={!onClick}
    >
      <span className={ok ? "flex size-10 items-center justify-center rounded-lg bg-success/12 text-success [&_svg]:size-5" : "flex size-10 items-center justify-center rounded-lg bg-warning/15 text-warning [&_svg]:size-5"}>
        {icon}
      </span>
      <span className="min-w-0">
        <small className="block text-xs text-muted-foreground">{label}</small>
        <strong className="block truncate text-sm">{value}</strong>
      </span>
      {ok ? <CheckCircle2 className="size-4 text-success" /> : <CircleAlert className="size-4 text-warning" />}
    </button>
  );
}

export default App;
