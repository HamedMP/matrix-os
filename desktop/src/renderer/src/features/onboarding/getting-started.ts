import { z } from "zod/v4";
import type { ApiClient } from "../../lib/api";
import { parseConnectedIntegrations } from "../integrations/types";

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

type Settled = PromiseSettledResult<unknown>;

function statusFrom(result: Settled, predicate: (value: unknown) => boolean): GettingStartedStepStatus {
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

function firstWorkStatus(projects: Settled, chats: Settled): GettingStartedStepStatus {
  const hasProjects = statusFrom(projects, (value) => ProjectsSchema.parse(value).projects.length > 0);
  const hasChats = statusFrom(chats, (value) => ChatsSchema.parse(value).items.length > 0);
  return alternativeCompletionStatus(hasProjects, hasChats);
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
    steps: GETTING_STARTED_STEP_IDS.map((id) => ({ id, label: STEP_LABELS[id], status: "unavailable" })),
  };
}

export async function loadGettingStartedSnapshot(
  api: Pick<ApiClient, "get">,
  signal?: AbortSignal,
): Promise<GettingStartedSnapshot> {
  const options = signal ? { signal } : undefined;
  const [github, integrations, agents, projects, chats, billing] = await Promise.allSettled([
    api.get("/api/github/status", options),
    api.get("/api/integrations", options),
    api.get("/api/agents/credentials/status", options),
    api.get("/api/workspace/projects", options),
    api.get("/api/chats?limit=1", options),
    api.get("/billing/status", options),
  ]);

  const githubCliStatus = statusFrom(github, (value) => GithubStatusSchema.parse(value).authenticated);
  const githubIntegrationStatus = statusFrom(integrations, (value) => (
    parseConnectedIntegrations(value).some((connection) => (
      connection.service === "github"
      && (connection.status === "active" || connection.status === "connected")
    ))
  ));
  const statuses: Record<GettingStartedStepId, GettingStartedStepStatus> = {
    github: alternativeCompletionStatus(githubCliStatus, githubIntegrationStatus),
    "email-calendar": statusFrom(integrations, (value) => {
      const activeServices = new Set(
        parseConnectedIntegrations(value)
          .filter((connection) => connection.status === "active" || connection.status === "connected")
          .map((connection) => connection.service),
      );
      return activeServices.has("gmail") && activeServices.has("google_calendar");
    }),
    agent: statusFrom(agents, (value) => AgentStatusSchema.parse(value).agents?.some((agent) => (
      (agent.agent === "codex" || agent.agent === "claude") && agent.status === "available"
    )) === true),
    "first-work": firstWorkStatus(projects, chats),
    billing: statusFrom(billing, (value) => BillingStatusSchema.parse(value).access.runtimeProxyAllowed),
  };

  const steps = GETTING_STARTED_STEP_IDS.map((id) => ({ id, label: STEP_LABELS[id], status: statuses[id] }));
  return {
    steps,
    completedCount: steps.filter((step) => step.status === "complete").length,
    loaded: true,
  };
}
