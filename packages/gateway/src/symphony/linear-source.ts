import { MAX_PREVIEW_TICKETS, sanitizeLabels, type TicketSourceRule, type TrackedTicket } from "./contracts.js";

export interface LinearSource {
  previewTickets(rule: TicketSourceRule, credential: string, input?: { limit?: number; state?: string }): Promise<{ tickets: TrackedTicket[]; truncated: boolean }>;
}

type FetchLike = typeof fetch;

interface LinearIssueNode {
  id?: string;
  identifier?: string;
  title?: string;
  description?: string | null;
  url?: string;
  priority?: number | null;
  updatedAt?: string;
  branchName?: string | null;
  assignee?: { id?: string; name?: string; displayName?: string } | null;
  state?: { id?: string; name?: string; type?: string } | null;
  team?: { id?: string; key?: string; name?: string } | null;
  labels?: { nodes?: Array<{ id?: string; name?: string }> } | null;
  project?: { id?: string; name?: string; slugId?: string } | null;
}

function normalizeIssue(node: LinearIssueNode): TrackedTicket | null {
  if (!node.id || !node.identifier || !node.title || !node.state?.name) return null;
  return {
    externalId: node.id,
    identifier: node.identifier,
    title: node.title,
    url: node.url,
    teamId: node.team?.id,
    teamKey: node.team?.key,
    projectId: node.project?.id,
    projectSlug: node.project?.slugId,
    stateName: node.state.name,
    stateType: node.state.type,
    assigneeId: node.assignee?.id,
    assigneeName: node.assignee?.displayName ?? node.assignee?.name,
    labels: sanitizeLabels(node.labels?.nodes?.map((label) => label.name ?? "") ?? []).map((label) => label.toLowerCase()),
    priority: node.priority,
    branchName: node.branchName ?? null,
    updatedAt: node.updatedAt,
  };
}

function includesAllLabels(ticket: TrackedTicket, requiredLabels: string[]): boolean {
  const actual = new Set(ticket.labels.map((label) => label.toLowerCase()));
  return requiredLabels.every((label) => actual.has(label.toLowerCase()));
}

function buildIssuesQuery(input: { projectId?: string; state?: string; labelName?: string; assigneeId?: string }) {
  const variableDefs = ["$first: Int!", "$after: String", "$teamId: String!"];
  const filters = ["team: { id: { eq: $teamId } }"];
  if (input.projectId) {
    variableDefs.push("$projectId: String!");
    filters.push("project: { id: { eq: $projectId } }");
  }
  if (input.state) {
    variableDefs.push("$state: String!");
    filters.push("state: { name: { eq: $state } }");
  }
  if (input.labelName) {
    variableDefs.push("$labelName: String!");
    filters.push("labels: { name: { eq: $labelName } }");
  }
  if (input.assigneeId) {
    variableDefs.push("$assigneeId: String!");
    filters.push("assignee: { id: { eq: $assigneeId } }");
  }
  return `
    query MatrixSymphonyIssues(
      ${variableDefs.join("\n      ")}
    ) {
      issues(
        first: $first
        after: $after
        orderBy: updatedAt
        filter: {
          ${filters.join("\n          ")}
        }
      ) {
        nodes {
          id identifier title description url priority updatedAt branchName
          assignee { id name displayName }
          state { id name type color }
          team { id key name }
          labels { nodes { id name } }
          project { id name slugId }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;
}

export function createLinearSource(options: {
  endpoint?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
} = {}): LinearSource {
  const endpoint = options.endpoint ?? "https://api.linear.app/graphql";
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;

  return {
    async previewTickets(rule: TicketSourceRule, credential: string, input: { limit?: number; state?: string } = {}) {
      const limit = Math.min(input.limit ?? 25, MAX_PREVIEW_TICKETS);
      const states = input.state ? [input.state] : rule.activeStates;
      const labelForServer = rule.requiredLabels[0];
      const assigneeIds = rule.assigneeIds.length > 0 ? rule.assigneeIds : [undefined];
      const tickets: TrackedTicket[] = [];
      let truncated = false;

      for (const state of states) {
        for (const assigneeId of assigneeIds) {
          if (tickets.length >= limit) break;
          const response = await fetchImpl(endpoint, {
            method: "POST",
            headers: {
              "Authorization": credential,
              "Content-Type": "application/json",
            },
          body: JSON.stringify({
              query: buildIssuesQuery({
                projectId: rule.projectId,
                state,
                labelName: labelForServer,
                assigneeId,
              }),
              variables: {
                first: Math.min(limit, 100),
                after: null,
                teamId: rule.teamId,
                ...(rule.projectId ? { projectId: rule.projectId } : {}),
                ...(state ? { state } : {}),
                ...(labelForServer ? { labelName: labelForServer } : {}),
                ...(assigneeId ? { assigneeId } : {}),
              },
            }),
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (!response.ok) {
            console.warn("[symphony] Linear preview failed with status", response.status);
            throw new Error("linear_preview_failed");
          }
          const payload = await response.json() as {
            data?: { issues?: { nodes?: LinearIssueNode[]; pageInfo?: { hasNextPage?: boolean } } };
            errors?: unknown[];
          };
          if (payload.errors) {
            console.warn("[symphony] Linear preview returned GraphQL errors");
            throw new Error("linear_preview_failed");
          }
          const nodes = payload.data?.issues?.nodes ?? [];
          for (const node of nodes) {
            const ticket = normalizeIssue(node);
            if (!ticket) continue;
            if (!includesAllLabels(ticket, rule.requiredLabels)) continue;
            if (rule.assigneeIds.length > 0 && (!ticket.assigneeId || !rule.assigneeIds.includes(ticket.assigneeId))) continue;
            tickets.push(ticket);
            if (tickets.length >= limit) break;
          }
          truncated ||= Boolean(payload.data?.issues?.pageInfo?.hasNextPage);
        }
      }
      return { tickets: tickets.slice(0, limit), truncated: truncated || tickets.length >= limit };
    },
  };
}
