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
}

export interface GettingStartedResults {
  github: PromiseSettledResult<unknown>;
  integrations: PromiseSettledResult<unknown>;
  agents: PromiseSettledResult<unknown>;
  projects: PromiseSettledResult<unknown>;
  chats: PromiseSettledResult<unknown>;
  billing: PromiseSettledResult<unknown>;
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
    steps: GETTING_STARTED_STEP_IDS.map((id) => ({
      id,
      label: STEP_LABELS[id],
      status: "unavailable",
    })),
  };
}

export function deriveGettingStartedSnapshot(
  results: GettingStartedResults,
): GettingStartedSnapshot {
  const githubCliStatus = statusFrom(
    results.github,
    (value) => GithubStatusSchema.parse(value).authenticated,
  );
  const githubIntegrationStatus = statusFrom(
    results.integrations,
    (value) => connectedServices(value).has("github"),
  );
  const statuses: Record<GettingStartedStepId, GettingStartedStepStatus> = {
    github: alternativeCompletionStatus(githubCliStatus, githubIntegrationStatus),
    "email-calendar": statusFrom(results.integrations, (value) => {
      const services = connectedServices(value);
      return services.has("gmail") && services.has("google_calendar");
    }),
    agent: statusFrom(results.agents, (value) => (
      AgentStatusSchema.parse(value).agents?.some((agent) => (
        (agent.agent === "codex" || agent.agent === "claude")
        && agent.status === "available"
      )) === true
    )),
    "first-work": alternativeCompletionStatus(
      statusFrom(results.projects, (value) => ProjectsSchema.parse(value).projects.length > 0),
      statusFrom(results.chats, (value) => ChatsSchema.parse(value).items.length > 0),
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
  };
}
