import { z } from "zod/v4";

export const GETTING_STARTED_STEP_IDS = [
  "github",
  "email-calendar",
  "agent",
  "first-work",
  "billing",
] as const;

export type GettingStartedStepId = (typeof GETTING_STARTED_STEP_IDS)[number];
export type GettingStartedStepStatus = "complete" | "incomplete" | "unavailable";

export interface GettingStartedStep {
  id: GettingStartedStepId;
  label: string;
  status: GettingStartedStepStatus;
}

export interface GettingStartedSnapshot {
  steps: GettingStartedStep[];
  completedCount: number;
  loaded: boolean;
  /** Signed-in coding agents ("codex", "claude"); null while unknown. */
  availableAgents: string[] | null;
  /** Connected integration services; null while unknown. */
  connectedServices: string[] | null;
}

export interface GettingStartedResults {
  github: PromiseSettledResult<unknown>;
  integrations: PromiseSettledResult<unknown>;
  agents: PromiseSettledResult<unknown>;
  projects: PromiseSettledResult<unknown>;
  chats: PromiseSettledResult<unknown>;
  billing: PromiseSettledResult<unknown>;
  /** Provider settings (`/api/ai/provider-settings`); optional for callers that do not read it. */
  providers?: PromiseSettledResult<unknown>;
}

const STEP_LABELS: Record<GettingStartedStepId, string> = {
  github: "Connect GitHub",
  "email-calendar": "Connect email & calendar",
  agent: "Log in to Codex / Claude",
  "first-work": "Clone a project or try a prompt",
  billing: "Set up billing",
};

const GithubStatusSchema = z.object({ authenticated: z.boolean() }).passthrough();
const AgentStatusSchema = z.object({
  agents: z.array(z.object({
    agent: z.string().max(64),
    status: z.string().max(32),
  }).passthrough()).max(32).optional(),
}).passthrough();
const ProjectsSchema = z.object({ projects: z.array(z.unknown()).max(200) }).passthrough();
const ChatsSchema = z.object({ items: z.array(z.unknown()).max(100) }).passthrough();
const BillingStatusSchema = z.object({
  access: z.object({ runtimeProxyAllowed: z.boolean() }).passthrough(),
}).passthrough();
/** The fields of GET /api/ai/provider-settings (`ProviderAccessSourceSchema`) the AI task reads. */
const OwnAccessSourcesSchema = z.object({
  accessSources: z.array(z.object({
    fundingKind: z.string().max(32),
    readiness: z.object({ state: z.string().max(32) }).passthrough(),
  }).passthrough()).max(64),
}).passthrough();
const OWN_FUNDING_KINDS: ReadonlySet<string> = new Set(["owner_account", "owner_api_key", "owner_subscription"]);
const ConnectedIntegrationSchema = z.object({
  id: z.string().min(1).max(64),
  service: z.string().min(1).max(64),
  status: z.string().min(1).max(32).optional(),
}).passthrough();

function asIntegrationList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.connections)) return record.connections;
  if (Array.isArray(record.services)) return record.services;
  return [];
}

function connectedServices(value: unknown): Set<string> {
  const services = new Set<string>();
  for (const candidate of asIntegrationList(value).slice(0, 200)) {
    const parsed = ConnectedIntegrationSchema.safeParse(candidate);
    if (!parsed.success) continue;
    const status = parsed.data.status ?? "active";
    if (status === "active" || status === "connected") services.add(parsed.data.service);
  }
  return services;
}

function statusFrom(
  result: PromiseSettledResult<unknown>,
  predicate: (value: unknown) => boolean,
): GettingStartedStepStatus {
  if (result.status === "rejected") return "unavailable";
  try {
    return predicate(result.value) ? "complete" : "incomplete";
  } catch (error: unknown) {
    console.warn(
      "[getting-started] invalid status response:",
      error instanceof Error ? error.name : typeof error,
    );
    return "unavailable";
  }
}

function alternativeCompletionStatus(
  ...statuses: GettingStartedStepStatus[]
): GettingStartedStepStatus {
  if (statuses.some((status) => status === "complete")) return "complete";
  if (statuses.every((status) => status === "incomplete")) return "incomplete";
  return "unavailable";
}

export function emptyGettingStartedSnapshot(): GettingStartedSnapshot {
  return {
    loaded: false,
    completedCount: 0,
    availableAgents: null,
    connectedServices: null,
    steps: GETTING_STARTED_STEP_IDS.map((id) => ({
      id,
      label: STEP_LABELS[id],
      status: "unavailable",
    })),
  };
}

/** The agents the agent step counts (Codex, Claude) that are signed in. */
function availableAgents(value: unknown): string[] {
  return (AgentStatusSchema.parse(value).agents ?? [])
    .filter((agent) => (agent.agent === "codex" || agent.agent === "claude") && agent.status === "available")
    .map((agent) => agent.agent);
}

/** GitHub counts when the gh CLI is signed in or the GitHub integration is connected. */
export function gettingStartedGithubStatus(results: GettingStartedResults): GettingStartedStepStatus {
  return alternativeCompletionStatus(
    statusFrom(results.github, (value) => GithubStatusSchema.parse(value).authenticated),
    statusFrom(results.integrations, (value) => connectedServices(value).has("github")),
  );
}

/** Whether every named integration service is connected. */
export function gettingStartedServicesStatus(
  results: GettingStartedResults,
  services: readonly string[],
): GettingStartedStepStatus {
  return statusFrom(results.integrations, (value) => {
    const connected = connectedServices(value);
    return services.every((service) => connected.has(service));
  });
}

/** Whether Codex or Claude is signed in. */
export function gettingStartedAgentStatus(results: GettingStartedResults): GettingStartedStepStatus {
  return statusFrom(results.agents, (value) => availableAgents(value).length > 0);
}

/** An own-account AI source counts too: a ready owner account or API key, with or without a coding agent CLI. */
export function gettingStartedAiProviderStatus(results: GettingStartedResults): GettingStartedStepStatus {
  const agent = gettingStartedAgentStatus(results);
  if (!results.providers) return agent;
  const ownAccess = statusFrom(results.providers, (value) => OwnAccessSourcesSchema.parse(value).accessSources
    .some((source) => OWN_FUNDING_KINDS.has(source.fundingKind) && source.readiness.state === "ready"));
  return alternativeCompletionStatus(agent, ownAccess);
}

/** Whether the owner has at least one chat. */
export function gettingStartedChatStatus(results: GettingStartedResults): GettingStartedStepStatus {
  return statusFrom(results.chats, (value) => ChatsSchema.parse(value).items.length > 0);
}

export function deriveGettingStartedSnapshot(
  results: GettingStartedResults,
): GettingStartedSnapshot {
  const statuses: Record<GettingStartedStepId, GettingStartedStepStatus> = {
    github: gettingStartedGithubStatus(results),
    "email-calendar": gettingStartedServicesStatus(results, ["gmail", "google_calendar"]),
    agent: gettingStartedAgentStatus(results),
    "first-work": alternativeCompletionStatus(
      statusFrom(results.projects, (value) => ProjectsSchema.parse(value).projects.length > 0),
      gettingStartedChatStatus(results),
    ),
    billing: statusFrom(
      results.billing,
      (value) => BillingStatusSchema.parse(value).access.runtimeProxyAllowed,
    ),
  };

  const steps = GETTING_STARTED_STEP_IDS.map((id) => ({
    id,
    label: STEP_LABELS[id],
    status: statuses[id],
  }));
  return {
    steps,
    completedCount: steps.filter((step) => step.status === "complete").length,
    loaded: true,
    availableAgents: results.agents.status === "fulfilled" && statuses.agent !== "unavailable" ? availableAgents(results.agents.value) : null,
    connectedServices: results.integrations.status === "fulfilled" ? [...connectedServices(results.integrations.value)] : null,
  };
}
