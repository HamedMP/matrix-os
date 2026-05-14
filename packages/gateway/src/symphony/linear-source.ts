import {
  MAX_PREVIEW_TICKETS,
  sanitizeLabels,
  type LinearProjectOption,
  type LinearSetupOptions,
  type LinearTeamOption,
  type LinearUserOption,
  type TicketSourceRule,
  type TrackedTicket,
} from "./contracts.js";

export interface LinearSource {
  discoverSetupOptions?(credential: string): Promise<LinearSetupOptions>;
  previewTickets(rule: TicketSourceRule, credential: string, input?: { limit?: number; state?: string }): Promise<{ tickets: TrackedTicket[]; truncated: boolean }>;
}

type FetchLike = typeof fetch;
const MAX_LINEAR_PREVIEW_REQUESTS = 20;
const MAX_SCAN_OFFSETS = 100;
const LINEAR_SETUP_PAGE_SIZE = 100;
const MAX_LINEAR_SETUP_PAGES = 50;

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

interface LinearIssuesPayload {
  data?: {
    issues?: {
      nodes?: LinearIssueNode[];
      pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
    };
  };
  errors?: unknown[];
}

interface LinearSetupPayload {
  data?: {
    teams?: {
      nodes?: Array<{ id?: string; key?: string; name?: string }>;
      pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
    };
    projects?: {
      nodes?: Array<{
        id?: string;
        name?: string;
        slugId?: string | null;
        teams?: { nodes?: Array<{ id?: string; key?: string; name?: string }> };
      }>;
      pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
    };
    users?: {
      nodes?: Array<{ id?: string; name?: string; displayName?: string | null; active?: boolean }>;
      pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
    };
  };
  errors?: unknown[];
}

function normalizeSetupOptions(payloads: LinearSetupPayload[]): LinearSetupOptions {
  const teams = new Map<string, LinearTeamOption>();
  const projects = new Map<string, LinearProjectOption>();
  const users = new Map<string, LinearUserOption>();

  for (const payload of payloads) {
    for (const node of payload.data?.teams?.nodes ?? []) {
      if (!node.id || !node.key || !node.name) continue;
      teams.set(node.id, { id: node.id, key: node.key, name: node.name });
    }

    for (const node of payload.data?.projects?.nodes ?? []) {
      if (!node.id || !node.name) continue;
      const teamIds = Array.from(new Set((node.teams?.nodes ?? []).map((team) => team.id).filter((id): id is string => Boolean(id))));
      const existing = projects.get(node.id);
      projects.set(node.id, {
        id: node.id,
        name: node.name,
        slug: node.slugId ?? existing?.slug,
        teamIds: Array.from(new Set([...(existing?.teamIds ?? []), ...teamIds])),
      });
    }

    for (const node of payload.data?.users?.nodes ?? []) {
      if (!node.id || !node.name) continue;
      users.set(node.id, {
        id: node.id,
        name: node.name,
        displayName: node.displayName ?? undefined,
        active: node.active,
      });
    }
  }

  return {
    teams: Array.from(teams.values()),
    projects: Array.from(projects.values()),
    users: Array.from(users.values()),
  };
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

const SETUP_OPTIONS_QUERY = `
  query MatrixSymphonySetupOptions(
    $first: Int!
    $teamsAfter: String
    $projectsAfter: String
    $usersAfter: String
    $includeTeams: Boolean!
    $includeProjects: Boolean!
    $includeUsers: Boolean!
  ) {
    teams(first: $first, after: $teamsAfter) @include(if: $includeTeams) {
      nodes { id key name }
      pageInfo { hasNextPage endCursor }
    }
    projects(first: $first, after: $projectsAfter) @include(if: $includeProjects) {
      nodes {
        id
        name
        slugId
        teams { nodes { id key name } }
      }
      pageInfo { hasNextPage endCursor }
    }
    users(first: $first, after: $usersAfter) @include(if: $includeUsers) {
      nodes { id name displayName active }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export function createLinearSource(options: {
  endpoint?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
} = {}): LinearSource {
  const endpoint = options.endpoint ?? "https://api.linear.app/graphql";
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const scanOffsets = new Map<string, number>();

  function scanKey(rule: TicketSourceRule, states: string[], assigneeIds: Array<string | undefined>): string {
    return JSON.stringify({
      teamId: rule.teamId,
      projectId: rule.projectId ?? null,
      label: rule.requiredLabels[0] ?? null,
      states,
      assigneeIds,
    });
  }

  function rememberScanOffset(key: string, offset: number): void {
    if (scanOffsets.has(key)) scanOffsets.delete(key);
    scanOffsets.set(key, offset);
    while (scanOffsets.size > MAX_SCAN_OFFSETS) {
      const oldest = scanOffsets.keys().next().value as string | undefined;
      if (!oldest) break;
      scanOffsets.delete(oldest);
    }
  }

  return {
    async discoverSetupOptions(credential: string): Promise<LinearSetupOptions> {
      const payloads: LinearSetupPayload[] = [];
      let teamsAfter: string | null = null;
      let projectsAfter: string | null = null;
      let usersAfter: string | null = null;
      let includeTeams = true;
      let includeProjects = true;
      let includeUsers = true;

      for (let page = 0; includeTeams || includeProjects || includeUsers; page += 1) {
        if (page >= MAX_LINEAR_SETUP_PAGES) {
          console.warn("[symphony] Linear setup discovery exceeded page cap");
          throw new Error("linear_setup_failed");
        }

        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            "Authorization": credential,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            query: SETUP_OPTIONS_QUERY,
            variables: {
              first: LINEAR_SETUP_PAGE_SIZE,
              teamsAfter,
              projectsAfter,
              usersAfter,
              includeTeams,
              includeProjects,
              includeUsers,
            },
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
          console.warn("[symphony] Linear setup discovery failed with status", response.status);
          throw new Error("linear_setup_failed");
        }
        const payload = await response.json() as LinearSetupPayload;
        if (payload.errors) {
          console.warn("[symphony] Linear setup discovery returned GraphQL errors");
          throw new Error("linear_setup_failed");
        }
        payloads.push(payload);

        const teamsPage = payload.data?.teams?.pageInfo;
        const projectsPage = payload.data?.projects?.pageInfo;
        const usersPage = payload.data?.users?.pageInfo;
        includeTeams = includeTeams && Boolean(teamsPage?.hasNextPage);
        includeProjects = includeProjects && Boolean(projectsPage?.hasNextPage);
        includeUsers = includeUsers && Boolean(usersPage?.hasNextPage);
        teamsAfter = teamsPage?.endCursor ?? null;
        projectsAfter = projectsPage?.endCursor ?? null;
        usersAfter = usersPage?.endCursor ?? null;
        if ((includeTeams && !teamsAfter) || (includeProjects && !projectsAfter) || (includeUsers && !usersAfter)) {
          console.warn("[symphony] Linear setup discovery returned an invalid pagination cursor");
          throw new Error("linear_setup_failed");
        }
      }
      return normalizeSetupOptions(payloads);
    },

    async previewTickets(rule: TicketSourceRule, credential: string, input: { limit?: number; state?: string } = {}) {
      const limit = Math.min(input.limit ?? 25, MAX_PREVIEW_TICKETS);
      const states = input.state ? [input.state] : rule.activeStates;
      const labelForServer = rule.requiredLabels[0];
      const assigneeIds = rule.assigneeIds.length > 0 ? rule.assigneeIds : [undefined];
      const activeStateNames = new Set(states.map((state) => state.toLowerCase()));
      const combinations = states.flatMap((state) => assigneeIds.map((assigneeId) => ({ state, assigneeId })));
      const key = scanKey(rule, states, assigneeIds);
      const startOffset = combinations.length > 0 ? (scanOffsets.get(key) ?? 0) % combinations.length : 0;
      const rotated = combinations.slice(startOffset).concat(combinations.slice(0, startOffset));
      const queue = rotated.map((combination) => ({ ...combination, after: null as string | null }));
      const tickets: TrackedTicket[] = [];
      let truncated = false;
      let requests = 0;

      while (queue.length > 0 && tickets.length < limit) {
        if (requests >= MAX_LINEAR_PREVIEW_REQUESTS) {
          truncated = true;
          rememberScanOffset(key, (startOffset + requests) % Math.max(combinations.length, 1));
          return { tickets: tickets.slice(0, limit), truncated };
        }
        const item = queue.shift()!;
        requests += 1;
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            "Authorization": credential,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            query: buildIssuesQuery({
              projectId: rule.projectId,
              state: item.state,
              labelName: labelForServer,
              assigneeId: item.assigneeId,
            }),
            variables: {
              first: Math.min(MAX_PREVIEW_TICKETS, 100),
              after: item.after,
              teamId: rule.teamId,
              ...(rule.projectId ? { projectId: rule.projectId } : {}),
              ...(item.state ? { state: item.state } : {}),
              ...(labelForServer ? { labelName: labelForServer } : {}),
              ...(item.assigneeId ? { assigneeId: item.assigneeId } : {}),
            },
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
          console.warn("[symphony] Linear preview failed with status", response.status);
          throw new Error("linear_preview_failed");
        }
        const payload = await response.json() as LinearIssuesPayload;
        if (payload.errors) {
          console.warn("[symphony] Linear preview returned GraphQL errors");
          throw new Error("linear_preview_failed");
        }
        const nodes = payload.data?.issues?.nodes ?? [];
        for (const node of nodes) {
          const ticket = normalizeIssue(node);
          if (!ticket) continue;
          if (activeStateNames.size > 0 && !activeStateNames.has(ticket.stateName.toLowerCase())) continue;
          if (!includesAllLabels(ticket, rule.requiredLabels)) continue;
          if (rule.assigneeIds.length > 0 && (!ticket.assigneeId || !rule.assigneeIds.includes(ticket.assigneeId))) continue;
          tickets.push(ticket);
          if (tickets.length >= limit) break;
        }
        const pageInfo = payload.data?.issues?.pageInfo;
        const hasNextPage = Boolean(pageInfo?.hasNextPage);
        const after = pageInfo?.endCursor ?? null;
        if (hasNextPage && !after) truncated = true;
        if (hasNextPage && after) {
          if (tickets.length < limit) queue.push({ state: item.state, assigneeId: item.assigneeId, after });
          else truncated = true;
        }
      }
      if (queue.length > 0) truncated = true;
      rememberScanOffset(key, queue.length > 0 ? (startOffset + requests) % Math.max(combinations.length, 1) : 0);
      return { tickets: tickets.slice(0, limit), truncated };
    },
  };
}
