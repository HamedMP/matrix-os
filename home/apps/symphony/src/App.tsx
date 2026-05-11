import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  Power,
  RefreshCw,
  Send,
  Settings2,
  Square,
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
const DEFAULT_RUNNER_PORT = 4066;
const LABEL_PAGE_SIZE = 250;
const LABEL_MAX_PAGES = 10;
const PROJECT_PAGE_SIZE = 100;
const PROJECT_MAX_PAGES = 10;
const ISSUE_PAGE_SIZE = 100;
const ISSUE_TARGET_COUNT = 50;
const ISSUE_MAX_PAGES = 5;
const REQUIRED_LABELS_MISSING_MESSAGE = "One or more required labels could not be found in the selected Linear team. Check that all required labels exist.";
const BOARD_INCOMPLETE_ERROR_PREFIX = "Board is incomplete:";
type SymphonyStateTemplate = { name: string; color: string; type: "backlog" | "unstarted" | "started" | "completed" | "canceled" };
const SYMPHONY_STATES: SymphonyStateTemplate[] = [
  { name: "Todo", color: "#6b7280", type: "unstarted" },
  { name: "In Progress", color: "#2563eb", type: "started" },
  { name: "Rework", color: "#db6e1f", type: "started" },
  { name: "Merging", color: "#0f783c", type: "started" },
];
const DEFAULT_ACTIVE_STATES = SYMPHONY_STATES.map((state) => state.name);
const REQUIRED_LABELS = ["symphony"];

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
  labels?: { nodes?: Array<{ id: string; name: string }> };
  project?: { id: string; name: string; slugId?: string };
};

type SymphonyRuntimeConfig = {
  version: 1;
  serviceRoot: string;
  binPath: string;
  workflowPath: string;
  port: number;
  tracker: {
    kind: "linear";
    teamKey: string;
    requiredLabels: string[];
    activeStates: string[];
  };
};

type SymphonyRuntimeStatus = {
  running: boolean;
  pid: number | null;
  startedAt: string | null;
  lastExitAt: string | null;
  lastExitCode: number | null;
  dashboardUrl: string;
  linearApiKeyConfigured: boolean;
  config: SymphonyRuntimeConfig;
};

type SymphonyRuntimeErrorCode =
  | "missing_linear_api_key"
  | "symphony_path_not_allowed"
  | "symphony_not_installed"
  | "symphony_start_failed"
  | "runtime_start_failed";

class SymphonyRuntimeError extends Error {
  readonly code: SymphonyRuntimeErrorCode;

  constructor(code: SymphonyRuntimeErrorCode) {
    super(code);
    this.name = "SymphonyRuntimeError";
    this.code = code;
  }
}

type SymphonyConfig = {
  repoUrl: string;
  cloneUrl: string;
  githubRepo: string;
  workflowPath: string;
  serviceRoot: string;
  binPath: string;
  runnerPort: number;
  teamKey: string;
  requiredLabels: string[];
  activeStates: string[];
  projectSlug: string;
  teamId: string;
  projectId: string;
  dashboardUrl: string;
};

const DEFAULT_CONFIG: SymphonyConfig = {
  repoUrl: "",
  cloneUrl: "",
  githubRepo: "",
  workflowPath: "~/code/symphony/WORKFLOW.md",
  serviceRoot: "~/code/symphony/elixir",
  binPath: "./bin/symphony",
  runnerPort: DEFAULT_RUNNER_PORT,
  teamKey: "MAT",
  requiredLabels: REQUIRED_LABELS,
  activeStates: DEFAULT_ACTIVE_STATES,
  projectSlug: "",
  teamId: "",
  projectId: "",
  dashboardUrl: `http://127.0.0.1:${DEFAULT_RUNNER_PORT}`,
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

async function fetchRuntimeStatus(): Promise<SymphonyRuntimeStatus | null> {
  const response = await fetch("/api/symphony/status", {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  return (await response.json()) as SymphonyRuntimeStatus;
}

async function saveRuntimeConfig(config: SymphonyConfig): Promise<SymphonyRuntimeConfig> {
  const response = await fetch("/api/symphony/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    body: JSON.stringify(runtimeConfigFromApp(config)),
  });
  if (!response.ok) throw new Error("runtime_config_failed");
  return (await response.json()) as SymphonyRuntimeConfig;
}

async function startRuntime(config: SymphonyConfig): Promise<SymphonyRuntimeStatus> {
  const response = await fetch("/api/symphony/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    body: JSON.stringify(runtimeConfigFromApp(config)),
  });
  if (!response.ok) throw await runtimeErrorFromResponse(response);
  return (await response.json()) as SymphonyRuntimeStatus;
}

async function stopRuntime(): Promise<SymphonyRuntimeStatus> {
  const response = await fetch("/api/symphony/stop", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    body: "{}",
  });
  if (!response.ok) throw new Error("runtime_stop_failed");
  return (await response.json()) as SymphonyRuntimeStatus;
}

async function runtimeErrorFromResponse(response: Response): Promise<SymphonyRuntimeError> {
  try {
    const payload = (await response.json()) as { error?: { code?: string } };
    if (payload.error?.code === "missing_linear_api_key" ||
      payload.error?.code === "symphony_path_not_allowed" ||
      payload.error?.code === "symphony_not_installed" ||
      payload.error?.code === "symphony_start_failed") {
      return new SymphonyRuntimeError(payload.error.code);
    }
  } catch (err: unknown) {
    console.warn("[symphony] start error body could not be read:", err instanceof Error ? err.message : String(err));
  }
  return new SymphonyRuntimeError("runtime_start_failed");
}

function startErrorMessage(err: unknown): string {
  if (err instanceof SymphonyRuntimeError) {
    switch (err.code) {
      case "missing_linear_api_key":
        return "Symphony runner could not be started because LINEAR_API_KEY is missing.";
      case "symphony_path_not_allowed":
        return "Symphony runner paths must stay inside the allowed local checkout roots.";
      case "symphony_not_installed":
        return "Symphony checkout, workflow, or runner binary could not be found or executed.";
      case "symphony_start_failed":
        return "Symphony runner exited during startup.";
      case "runtime_start_failed":
        return "Symphony runner could not be started.";
    }
  }
  return "Symphony runner could not be started.";
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

function runtimeConfigFromApp(config: SymphonyConfig): Omit<SymphonyRuntimeConfig, "version"> {
  return {
    serviceRoot: config.serviceRoot,
    binPath: config.binPath,
    workflowPath: config.workflowPath,
    port: config.runnerPort,
    tracker: {
      kind: "linear",
      teamKey: config.teamKey,
      requiredLabels: config.requiredLabels,
      activeStates: config.activeStates,
    },
  };
}

function mergeRuntimeConfig(config: SymphonyConfig, status: SymphonyRuntimeStatus | null): SymphonyConfig {
  if (!status) return config;
  return {
    ...config,
    workflowPath: status.config.workflowPath,
    serviceRoot: status.config.serviceRoot,
    binPath: status.config.binPath,
    runnerPort: status.config.port,
    teamKey: status.config.tracker.teamKey,
    requiredLabels: status.config.tracker.requiredLabels,
    activeStates: status.config.tracker.activeStates,
    dashboardUrl: status.dashboardUrl,
  };
}

function statusAfterSavedRuntimeConfig(
  current: SymphonyRuntimeStatus | null,
  runtimeConfig: SymphonyRuntimeConfig,
): SymphonyRuntimeStatus | null {
  if (!current || current.running) return current;
  return {
    ...current,
    dashboardUrl: `http://127.0.0.1:${runtimeConfig.port}`,
    config: runtimeConfig,
  };
}

function normalizeNameList(values: string[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const value of values) {
    const name = value.trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

function templateForActiveState(name: string): SymphonyStateTemplate {
  const builtIn = SYMPHONY_STATES.find((state) => state.name.toLowerCase() === name.toLowerCase());
  return builtIn ? { ...builtIn, name } : { name, color: "#2563eb", type: "started" };
}

function templatesForActiveStates(activeStates: string[]): SymphonyStateTemplate[] {
  return normalizeNameList(activeStates).map(templateForActiveState);
}

function selectLinearTeamId(config: SymphonyConfig, teams: Team[]): string {
  const keyMatch = teams.find((team) => team.key.toLowerCase() === config.teamKey.toLowerCase());
  if (keyMatch) return keyMatch.id;
  if (config.teamId && teams.some((team) => team.id === config.teamId)) return config.teamId;
  return teams[0]?.id ?? "";
}

function projectBelongsToTeam(project: Project, teamId: string): boolean {
  if (!teamId) return true;
  return (project.teams?.nodes ?? []).some((team) => team.id === teamId);
}

function projectsForTeam(projects: Project[], teamId: string): Project[] {
  return projects.filter((project) => projectBelongsToTeam(project, teamId));
}

function selectLinearProjectId(config: SymphonyConfig, projects: Project[], teamId: string): string {
  const teamProjects = projectsForTeam(projects, teamId);
  if (config.projectId && teamProjects.some((project) => project.id === config.projectId)) return config.projectId;
  const slugMatch = teamProjects.find((project) => project.slugId?.toLowerCase() === config.projectSlug.toLowerCase());
  return slugMatch?.id ?? "";
}

async function fetchRequiredLinearLabelIds(teamId: string, labelNames: string[]): Promise<string[]> {
  const names = labelNames.map((label) => label.trim()).filter(Boolean);
  if (names.length === 0) return [];
  const required = new Set(names.map((label) => label.toLowerCase()));
  const found = new Map<string, string>();
  let after: string | undefined;
  for (let page = 0; page < LABEL_MAX_PAGES && found.size < required.size; page += 1) {
    const payload = await callService<unknown>("linear", "graphql", {
      query: `
        query MatrixSymphonyLabels($teamId: String!, $first: Int!, $after: String) {
          issueLabels(first: $first, after: $after, filter: { team: { id: { eq: $teamId } } }) {
            nodes { id name }
            pageInfo { hasNextPage endCursor }
          }
        }
      `,
      variables: { teamId, first: LABEL_PAGE_SIZE, after: after ?? null },
    });
    const issueLabels = graphData<{
      issueLabels?: {
        nodes?: Array<{ id: string; name: string }>;
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
      };
    }>(payload).issueLabels;
    for (const label of issueLabels?.nodes ?? []) {
      const normalized = label.name.toLowerCase();
      if (required.has(normalized)) found.set(normalized, label.id);
    }
    if (!issueLabels?.pageInfo?.hasNextPage || !issueLabels.pageInfo.endCursor) break;
    after = issueLabels.pageInfo.endCursor;
  }
  return names.map((label) => found.get(label.toLowerCase())).filter((id): id is string => Boolean(id));
}

async function fetchLinearProjects(): Promise<Project[]> {
  const projects: Project[] = [];
  let after: string | undefined;
  for (let page = 0; page < PROJECT_MAX_PAGES; page += 1) {
    const payload = await callService<unknown>("linear", "list_projects", {
      first: PROJECT_PAGE_SIZE,
      ...(after ? { after } : {}),
    });
    const projectData = graphData<{
      projects?: {
        nodes?: Project[];
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
      };
    }>(payload).projects;
    projects.push(...(projectData?.nodes ?? []));
    const endCursor = projectData?.pageInfo?.endCursor;
    if (!projectData?.pageInfo?.hasNextPage || !endCursor) break;
    after = endCursor;
  }
  return projects;
}

function issueHasRequiredLabels(issue: Issue, labelNames: string[]): boolean {
  const required = labelNames.map((label) => label.trim().toLowerCase()).filter(Boolean);
  if (required.length === 0) return true;
  const issueLabels = new Set((issue.labels?.nodes ?? []).map((label) => label.name.toLowerCase()));
  return required.every((label) => issueLabels.has(label));
}

function workflowStateBelongsToTeam(state: WorkflowState, teamId: string): boolean {
  if (!teamId) return true;
  return state.team?.id === teamId;
}

function boardIncompleteMessage(collected: number, pages: number): string {
  return `${BOARD_INCOMPLETE_ERROR_PREFIX} only ${collected} of ${ISSUE_TARGET_COUNT} target issues found after scanning ${pages} pages. Consider reducing the number of required labels.`;
}

function safeLinearErrorMessage(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  if (err.message === REQUIRED_LABELS_MISSING_MESSAGE) return err.message;
  if (err.message.startsWith(BOARD_INCOMPLETE_ERROR_PREFIX)) return err.message;
  return null;
}

async function fetchLinearIssues(baseConfig: SymphonyConfig, teamId: string, projectId: string, selectedState: string): Promise<Issue[]> {
  const collected: Issue[] = [];
  const requiredLabels = baseConfig.requiredLabels.map((label) => label.trim()).filter(Boolean);
  let after: string | undefined;
  let pagesFetched = 0;
  let hitPageCap = false;
  for (let page = 0; page < ISSUE_MAX_PAGES && collected.length < ISSUE_TARGET_COUNT; page += 1) {
    const issuePayload = await callService<unknown>("linear", "list_issues", {
      teamId,
      projectId: projectId || undefined,
      state: selectedState || undefined,
      ...(requiredLabels[0] ? { labelName: requiredLabels[0] } : {}),
      first: ISSUE_PAGE_SIZE,
      ...(after ? { after } : {}),
    });
    const issueData = graphData<{
      issues?: {
        nodes?: Issue[];
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
      };
    }>(issuePayload).issues;
    collected.push(...(issueData?.nodes ?? []).filter((issue) => issueHasRequiredLabels(issue, baseConfig.requiredLabels)));
    pagesFetched = page + 1;
    const endCursor = issueData?.pageInfo?.endCursor;
    if (!issueData?.pageInfo?.hasNextPage || !endCursor) break;
    if (page + 1 >= ISSUE_MAX_PAGES) {
      hitPageCap = true;
      break;
    }
    after = endCursor;
  }
  if (requiredLabels.length > 1 && hitPageCap && collected.length < ISSUE_TARGET_COUNT) {
    console.warn("[symphony] Linear issue label filter reached the page cap before filling the board", {
      collected: collected.length,
      pages: pagesFetched,
      requiredLabels: requiredLabels.length,
    });
    throw new Error(boardIncompleteMessage(collected.length, pagesFetched));
  }
  return collected.slice(0, ISSUE_TARGET_COUNT);
}

function stateBadgeVariant(stateName: string | undefined): "secondary" | "success" | "warning" | "outline" {
  if (!stateName) return "outline";
  if (stateName === "Merging") return "success";
  if (stateName === "Rework") return "warning";
  return "secondary";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function App() {
  const [config, setConfig] = useState<SymphonyConfig>(DEFAULT_CONFIG);
  const configRef = useRef(DEFAULT_CONFIG);
  const configSaveSequenceRef = useRef(0);
  const [requiredLabelsInput, setRequiredLabelsInput] = useState(DEFAULT_CONFIG.requiredLabels.join(", "));
  const [activeStatesInput, setActiveStatesInput] = useState(DEFAULT_CONFIG.activeStates.join(", "));
  const [focusedListField, setFocusedListField] = useState<"requiredLabels" | "activeStates" | null>(null);
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
  const [runtimeStatus, setRuntimeStatus] = useState<SymphonyRuntimeStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const linearConnection = useMemo(() => connectionFor(connections, "linear"), [connections]);
  const githubConnection = useMemo(() => connectionFor(connections, "github"), [connections]);
  const visibleProjects = useMemo(() => projectsForTeam(projects, config.teamId), [projects, config.teamId]);
  const selectedProject = visibleProjects.find((project) => project.id === config.projectId);
  const activeStateTemplates = useMemo(() => templatesForActiveStates(config.activeStates), [config.activeStates]);
  const boardStates = useMemo(() => activeStateTemplates.map((state) => state.name), [activeStateTemplates]);
  const missingSymphonyStates = activeStateTemplates.filter(
    (required) => !states.some((state) => (
      workflowStateBelongsToTeam(state, config.teamId) &&
      state.name.toLowerCase() === required.name.toLowerCase()
    )),
  );

  useEffect(() => {
    if (focusedListField !== "requiredLabels") setRequiredLabelsInput(config.requiredLabels.join(", "));
  }, [config.requiredLabels, focusedListField]);

  useEffect(() => {
    if (focusedListField !== "activeStates") setActiveStatesInput(config.activeStates.join(", "));
  }, [config.activeStates, focusedListField]);

  useEffect(() => {
    configRef.current = config;
  }, [config]);

  const saveConfig = useCallback(async (next: SymphonyConfig) => {
    const previous = configRef.current;
    const saveId = configSaveSequenceRef.current + 1;
    configSaveSequenceRef.current = saveId;
    configRef.current = next;
    setConfig(next);
    setError(null);
    try {
      const runtimeConfig = await saveRuntimeConfig(next);
      await writeConfig(next);
      if (configSaveSequenceRef.current === saveId) {
        setRuntimeStatus((current) => statusAfterSavedRuntimeConfig(current, runtimeConfig));
      }
    } catch (err: unknown) {
      console.warn("[symphony] config save failed:", err instanceof Error ? err.message : String(err));
      if (configSaveSequenceRef.current === saveId) {
        configRef.current = previous;
        setConfig(previous);
        setError("Symphony settings could not be saved.");
      }
    }
  }, []);

  const updateConfig = useCallback((patch: Partial<SymphonyConfig>) => {
    setConfig((current) => ({ ...current, ...patch }));
  }, []);

  const persistConfig = useCallback(async () => {
    try {
      const runtimeConfig = await saveRuntimeConfig(config);
      await writeConfig(config);
      setRuntimeStatus((current) => statusAfterSavedRuntimeConfig(current, runtimeConfig));
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
      const [teamPayload, nextProjects] = await Promise.all([
        callService<unknown>("linear", "list_teams", { first: 100 }),
        fetchLinearProjects(),
      ]);
      const nextTeams = graphData<{ teams?: { nodes?: Team[] } }>(teamPayload).teams?.nodes ?? [];
      const teamId = selectLinearTeamId(baseConfig, nextTeams);
      const projectId = selectLinearProjectId(baseConfig, nextProjects, teamId);
      const selectedTeam = nextTeams.find((team) => team.id === teamId);
      const selectedLinearProject = nextProjects.find((project) => project.id === projectId);
      const nextConfig = {
        ...baseConfig,
        teamId,
        teamKey: selectedTeam?.key ?? baseConfig.teamKey,
        projectId,
        projectSlug: selectedLinearProject?.slugId ?? "",
      };
      setTeams(nextTeams);
      setProjects(nextProjects);
      setConfig(nextConfig);
      if (teamId) {
        const [statePayload, nextIssues] = await Promise.all([
          callService<unknown>("linear", "list_workflow_states", { teamId, first: 100 }),
          fetchLinearIssues(baseConfig, teamId, projectId, selectedState),
        ]);
        setStates(graphData<{ workflowStates?: { nodes?: WorkflowState[] } }>(statePayload).workflowStates?.nodes ?? []);
        setIssues(nextIssues);
      }
    } catch (err: unknown) {
      console.warn("[symphony] Linear refresh failed:", err instanceof Error ? err.message : String(err));
      setError(safeLinearErrorMessage(err) ?? "Linear data could not be loaded.");
    } finally {
      setBusy(null);
    }
  }, [config, linearConnection, selectedState]);

  useEffect(() => {
    Promise.all([readConfig(), fetchConnections(), fetchRuntimeStatus()])
      .then(([storedConfig, storedConnections, storedRuntimeStatus]) => {
        setRuntimeStatus(storedRuntimeStatus);
        setConfig(mergeRuntimeConfig(storedConfig, storedRuntimeStatus));
        setConnections(storedConnections);
      })
      .catch((err: unknown) => {
        console.warn("[symphony] startup failed:", err instanceof Error ? err.message : String(err));
        setError("Symphony could not load saved settings.");
      });
  }, []);

  useEffect(() => {
    setSelectedState((current) => boardStates.includes(current) ? current : boardStates[0] ?? "");
  }, [boardStates]);

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
          type: state.type,
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
      const labelIds = await fetchRequiredLinearLabelIds(config.teamId, config.requiredLabels);
      if (config.requiredLabels.length > 0 && labelIds.length < config.requiredLabels.length) {
        throw new Error(REQUIRED_LABELS_MISSING_MESSAGE);
      }
      const selectedWorkflowState = states.find((state) => (
        workflowStateBelongsToTeam(state, config.teamId) &&
        state.name.toLowerCase() === selectedState.toLowerCase()
      ));
      await callService("linear", "create_issue", {
        teamId: config.teamId,
        projectId: config.projectId || undefined,
        stateId: selectedWorkflowState?.id,
        title: newIssueTitle.trim(),
        description: newIssueDescription.trim() || undefined,
        labelIds,
      });
      setNewIssueTitle("");
      setNewIssueDescription("");
      await refreshLinear();
    } catch (err: unknown) {
      console.warn("[symphony] issue creation failed:", err instanceof Error ? err.message : String(err));
      setError(safeLinearErrorMessage(err) ?? "Issue could not be created.");
    } finally {
      setBusy(null);
    }
  }, [config.projectId, config.requiredLabels, config.teamId, newIssueDescription, newIssueTitle, refreshLinear, selectedState, states]);

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

  const refreshRuntime = useCallback(async () => {
    setBusy("Refreshing runner");
    setError(null);
    try {
      const next = await fetchRuntimeStatus();
      setRuntimeStatus(next);
      if (next) setConfig((current) => mergeRuntimeConfig(current, next));
    } catch (err: unknown) {
      console.warn("[symphony] runtime refresh failed:", err instanceof Error ? err.message : String(err));
      setError("Symphony runner status could not be loaded.");
    } finally {
      setBusy(null);
    }
  }, []);

  const runStartRuntime = useCallback(async () => {
    setBusy("Starting runner");
    setError(null);
    try {
      const next = await startRuntime(config);
      setRuntimeStatus(next);
      setConfig((current) => mergeRuntimeConfig(current, next));
    } catch (err: unknown) {
      console.warn("[symphony] runtime start failed:", err instanceof Error ? err.message : String(err));
      setError(startErrorMessage(err));
    } finally {
      setBusy(null);
    }
  }, [config]);

  const runStopRuntime = useCallback(async () => {
    setBusy("Stopping runner");
    setError(null);
    try {
      const next = await stopRuntime();
      setRuntimeStatus(next);
      setConfig((current) => mergeRuntimeConfig(current, next));
    } catch (err: unknown) {
      console.warn("[symphony] runtime stop failed:", err instanceof Error ? err.message : String(err));
      setError("Symphony runner could not be stopped.");
    } finally {
      setBusy(null);
    }
  }, []);

  const command = [
    "cd " + shellQuote(config.serviceRoot),
    `LINEAR_API_KEY=... mise exec -- ${shellQuote(config.binPath)} ${shellQuote(config.workflowPath)} --port ${config.runnerPort} --i-understand-that-this-will-be-running-without-the-usual-guardrails`,
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
          <Button variant="outline" onClick={refreshRuntime} disabled={Boolean(busy)}>
            <RefreshCw />Runner
          </Button>
          <Button onClick={() => window.open(runtimeStatus?.dashboardUrl ?? config.dashboardUrl, "_blank", "noopener,noreferrer")}>
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

      <section className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <StatusCard icon={<Power />} label="Runner" value={runtimeStatus?.running ? `Running :${runtimeStatus.config.port}` : "Stopped"} ok={Boolean(runtimeStatus?.running)} />
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
              <Field label="Symphony checkout">
                <Input value={config.serviceRoot} onChange={(event) => updateConfig({ serviceRoot: event.target.value })} onBlur={persistConfig} />
              </Field>
              <Field label="Runner binary">
                <Input value={config.binPath} onChange={(event) => updateConfig({ binPath: event.target.value })} onBlur={persistConfig} />
              </Field>
              <Field label="Runner port">
                <Input type="number" min={1024} max={65535} value={config.runnerPort} onChange={(event) => updateConfig({ runnerPort: Number(event.target.value) || DEFAULT_RUNNER_PORT })} onBlur={persistConfig} />
              </Field>
              <Field label="Linear team key">
                <Input value={config.teamKey} onChange={(event) => updateConfig({ teamKey: event.target.value })} onBlur={persistConfig} />
              </Field>
              <Field label="Required labels">
                <Input value={requiredLabelsInput} onFocus={() => setFocusedListField("requiredLabels")} onChange={(event) => setRequiredLabelsInput(event.target.value)} onBlur={() => {
                  setFocusedListField(null);
                  void saveConfig({ ...config, requiredLabels: normalizeNameList(requiredLabelsInput.split(",")) });
                }} />
              </Field>
              <Field label="Active states">
                <Input value={activeStatesInput} onFocus={() => setFocusedListField("activeStates")} onChange={(event) => setActiveStatesInput(event.target.value)} onBlur={() => {
                  setFocusedListField(null);
                  void saveConfig({ ...config, activeStates: normalizeNameList(activeStatesInput.split(",")) });
                }} />
              </Field>
              <Field label="Project slug">
                <Input value={config.projectSlug} onChange={(event) => updateConfig({ projectSlug: event.target.value })} onBlur={persistConfig} placeholder="Linear slugId" />
              </Field>
              <Field label="Team">
                <Select value={config.teamId} onChange={(event) => {
                  const team = teams.find((candidate) => candidate.id === event.target.value);
                  void saveConfig({
                    ...config,
                    teamId: event.target.value,
                    teamKey: team?.key ?? config.teamKey,
                    projectId: "",
                    projectSlug: "",
                  });
                }}>
                  <option value="">Select team</option>
                  {teams.map((team) => <option key={team.id} value={team.id}>{team.key} - {team.name}</option>)}
                </Select>
              </Field>
              <Field label="Project">
                <Select value={config.projectId} onChange={(event) => saveConfig({ ...config, projectId: event.target.value, projectSlug: visibleProjects.find((project) => project.id === event.target.value)?.slugId ?? "" })}>
                  <option value="">No project filter</option>
                  {visibleProjects.map((project) => <option key={project.id} value={project.id}>{project.slugId ?? project.name}</option>)}
                </Select>
              </Field>
            </div>

            <div className="grid gap-2 rounded-lg border bg-muted/30 p-3 text-sm md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
              <div className="min-w-0">
                <div className="font-semibold">{runtimeStatus?.running ? `Running on port ${runtimeStatus.config.port}` : "Local runner stopped"}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {runtimeStatus?.linearApiKeyConfigured ? "LINEAR_API_KEY is available" : "LINEAR_API_KEY is missing"}
                  {runtimeStatus?.pid ? ` · pid ${runtimeStatus.pid}` : ""}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button onClick={runStartRuntime} disabled={Boolean(busy) || Boolean(runtimeStatus?.running)}>
                  <Play />Start
                </Button>
                <Button variant="outline" onClick={runStopRuntime} disabled={Boolean(busy) || !runtimeStatus?.running}>
                  <Square />Stop
                </Button>
              </div>
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
                {boardStates.map((state) => (
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
                    {issue.labels?.nodes?.length ? ` · ${issue.labels.nodes.map((label) => label.name).join(", ")}` : ""}
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
