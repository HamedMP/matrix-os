import type { ServiceAction, ServiceDefinition } from "./types.js";
import { EXPANSION_SERVICE_REGISTRY } from "./registry-expansion.js";
import type { PipedreamConnectClient } from "./pipedream.js";
import { GMAIL_SERVICE } from "./gmail.js";
import { GOOGLE_SERVICES } from "./google.js";
import { listValidation } from "./list-validation.js";

const LOGO_BASE = "https://pipedream.com/s.v0";

// GitHub repo names follow `owner/repo` where each segment matches GitHub's
// allowed character set: alphanumerics plus `-`, `_`, `.`. We validate strictly
// before URL-encoding to refuse `..`, slashes, or any character that could
// inject extra path segments. Throws synchronously if the input is malformed
// -- the calling /call route will surface this as a 502 with the literal error
// message preserved in logs.
const GITHUB_NAME_RE = /^[A-Za-z0-9._-]+$/;
function encodeOwnerRepo(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("repo must be a string in owner/name format");
  }
  const parts = value.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`repo must be in owner/name format, got: ${value}`);
  }
  const [owner, repo] = parts;
  if (!GITHUB_NAME_RE.test(owner) || !GITHUB_NAME_RE.test(repo)) {
    throw new Error(`repo contains invalid characters: ${value}`);
  }
  return `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

// Discord snowflakes are 17-20 digit numeric strings. Strict numeric check
// refuses path traversal and any non-digit input before we interpolate it
// into a real Discord API URL.
const DISCORD_SNOWFLAKE_RE = /^\d{17,20}$/;
function encodeDiscordSnowflake(value: unknown): string {
  if (typeof value !== "string" || !DISCORD_SNOWFLAKE_RE.test(value)) {
    throw new Error(`Discord ID must be a 17-20 digit numeric string, got: ${String(value)}`);
  }
  return value;
}

function cappedPositiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArrayOrUndefined(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function linearGraphqlBody(query: string, variables?: Record<string, unknown>): Record<string, unknown> {
  return variables ? { query, variables } : { query };
}

type RegistryServiceInput = Omit<ServiceDefinition, "actions" | "connectorKind"> & {
  connectorKind?: ServiceDefinition["connectorKind"];
  actions: ServiceDefinition["actions"];
};

function defineServiceRegistry(
  input: Record<string, RegistryServiceInput>,
): Record<string, ServiceDefinition> {
  return Object.fromEntries(Object.entries(input).map(([serviceId, service]) => [
    serviceId,
    {
      ...service,
      connectorKind: service.connectorKind ?? "pipedream",
    },
  ])) as Record<string, ServiceDefinition>;
}

export const SERVICE_REGISTRY: Record<string, ServiceDefinition> = defineServiceRegistry({
  gmail: GMAIL_SERVICE,

  ...GOOGLE_SERVICES,

  github: {
    id: "github",
    name: "GitHub",
    category: "developer",
    pipedreamApp: "github",
    icon: "github",
    logoUrl: `${LOGO_BASE}/github/logo/48`,
    // GitHub-specific note on `repo` param: callers MUST pass `owner/name`
    // (e.g. `octocat/hello-world`). The encodeOwnerRepo helper validates and
    // URL-encodes each segment so a value like `bad/../path` is rejected
    // before it hits the GitHub API. If parsing fails, the action throws
    // synchronously inside the URL builder and the /call route returns 502
    // with an "Integration call failed" message -- not ideal UX, but safer
    // than smuggling arbitrary path segments into a real URL.
    actions: {
      // GitHub API: GET /user/repos. Defaults to sort=updated so the most
      // active repos surface first; matches what `gh repo list` does.
      list_repos: {
        description: "List repositories",
        risk: "read",
        paramsSchema: listValidation.repos,
        params: {
          page: { type: "number" },
          sort: { type: "string" },
          per_page: { type: "number" },
        },
        directApi: {
          method: "GET",
          url: "https://api.github.com/user/repos",
          mapParams: (p) => ({
            ...(p.page !== undefined ? { page: String(p.page) } : {}),
            sort: p.sort ? String(p.sort) : "updated",
            per_page: p.per_page ? String(p.per_page) : "30",
          }),
        },
      },
      // GitHub API: GET /repos/{owner}/{repo}/issues. Defaults to state=open.
      // GitHub returns PRs in the issues feed -- callers who only want pure
      // issues should filter on `pull_request === null` client-side.
      list_issues: {
        description: "List issues for a repository (use owner/repo format)",
        risk: "read",
        paramsSchema: listValidation.issues,
        params: {
          page: { type: "number" },
          per_page: { type: "number" },
          repo: { type: "string", required: true },
          state: { type: "string" },
        },
        directApi: {
          method: "GET",
          url: (p) => `https://api.github.com/repos/${encodeOwnerRepo(p.repo)}/issues`,
          mapParams: (p) => ({
            ...(p.page !== undefined ? { page: String(p.page) } : {}),
            ...(p.per_page !== undefined ? { per_page: String(p.per_page) } : {}),
            state: p.state ? String(p.state) : "open",
          }),
        },
      },
      // GitHub API: POST /repos/{owner}/{repo}/issues. `labels` is a
      // comma-separated string in our params; GitHub wants an array, so we
      // split here. Empty string -> no labels, not a single empty label.
      create_issue: {
        description: "Create a new issue (use owner/repo format)",
        risk: "write",
        params: {
          repo: { type: "string", required: true },
          title: { type: "string", required: true },
          body: { type: "string" },
          labels: { type: "string" },
        },
        directApi: {
          method: "POST",
          url: (p) => `https://api.github.com/repos/${encodeOwnerRepo(p.repo)}/issues`,
          mapBody: (p) => ({
            title: String(p.title),
            ...(p.body ? { body: String(p.body) } : {}),
            ...(p.labels
              ? { labels: String(p.labels).split(",").map((l) => l.trim()).filter(Boolean) }
              : {}),
          }),
        },
      },
      // GitHub API: GET /repos/{owner}/{repo}/pulls.
      list_prs: {
        description: "List pull requests for a repository (use owner/repo format)",
        risk: "read",
        paramsSchema: listValidation.issues,
        params: {
          page: { type: "number" },
          per_page: { type: "number" },
          repo: { type: "string", required: true },
          state: { type: "string" },
        },
        directApi: {
          method: "GET",
          url: (p) => `https://api.github.com/repos/${encodeOwnerRepo(p.repo)}/pulls`,
          mapParams: (p) => ({
            ...(p.page !== undefined ? { page: String(p.page) } : {}),
            ...(p.per_page !== undefined ? { per_page: String(p.per_page) } : {}),
            state: p.state ? String(p.state) : "open",
          }),
        },
      },
      // GitHub API: GET /notifications. `all=true` includes already-read; the
      // default is unread only.
      get_notifications: {
        description: "Get notifications",
        risk: "read",
        paramsSchema: listValidation.notifications,
        params: {
          page: { type: "number" },
          per_page: { type: "number" },
          all: { type: "boolean" },
        },
        directApi: {
          method: "GET",
          url: "https://api.github.com/notifications",
          mapParams: (p) => ({
            ...(p.page !== undefined ? { page: String(p.page) } : {}),
            ...(p.per_page !== undefined ? { per_page: String(p.per_page) } : {}),
            all: p.all ? "true" : "false",
          }),
        },
      },
    },
  },

  linear: {
    id: "linear",
    name: "Linear",
    category: "developer",
    pipedreamApp: "linear",
    icon: "code",
    logoUrl: `${LOGO_BASE}/linear/logo/48`,
    actions: {
      viewer: {
        description: "Get the connected Linear user",
        risk: "read",
        params: {},
        directApi: {
          method: "POST",
          url: "https://api.linear.app/graphql",
          mapBody: () => linearGraphqlBody(`
            query MatrixLinearViewer {
              viewer { id name displayName email }
            }
          `),
        },
      },
      list_teams: {
        description: "List Linear teams",
        risk: "read",
        params: {
          first: { type: "number" },
        },
        directApi: {
          method: "POST",
          url: "https://api.linear.app/graphql",
          mapBody: (p) => linearGraphqlBody(`
            query MatrixLinearTeams($first: Int!) {
              teams(first: $first) {
                nodes { id key name description }
              }
            }
          `, { first: cappedPositiveInt(p.first, 50, 100) }),
        },
      },
      list_projects: {
        description: "List Linear projects",
        risk: "read",
        params: {
          first: { type: "number" },
          after: { type: "string" },
        },
        directApi: {
          method: "POST",
          url: "https://api.linear.app/graphql",
          mapBody: (p) => linearGraphqlBody(`
            query MatrixLinearProjects($first: Int!, $after: String) {
              projects(first: $first, after: $after) {
                nodes {
                  id
                  name
                  slugId
                  state
                  description
                  teams { nodes { id key name } }
                }
                pageInfo { hasNextPage endCursor }
              }
            }
          `, {
            first: cappedPositiveInt(p.first, 50, 100),
            after: typeof p.after === "string" && p.after.trim() ? p.after : null,
          }),
        },
      },
      list_workflow_states: {
        description: "List workflow states for a Linear team",
        risk: "read",
        params: {
          teamId: { type: "string", required: true },
          first: { type: "number" },
        },
        directApi: {
          method: "POST",
          url: "https://api.linear.app/graphql",
          mapBody: (p) => linearGraphqlBody(`
            query MatrixLinearWorkflowStates($teamId: String!, $first: Int!) {
              workflowStates(first: $first, filter: { team: { id: { eq: $teamId } } }) {
                nodes { id name type color position team { id key name } }
              }
            }
          `, {
            teamId: String(p.teamId),
            first: cappedPositiveInt(p.first, 50, 100),
          }),
        },
      },
      list_issues: {
        description: "List Linear issues, optionally filtered by team, project, or state name",
        risk: "read",
        params: {
          first: { type: "number" },
          teamId: { type: "string" },
          projectId: { type: "string" },
          state: { type: "string" },
          labelName: { type: "string" },
          after: { type: "string" },
        },
        directApi: {
          method: "POST",
          url: "https://api.linear.app/graphql",
          mapBody: (p) => {
            const teamId = stringOrUndefined(p.teamId);
            const projectId = stringOrUndefined(p.projectId);
            const state = stringOrUndefined(p.state);
            const labelName = stringOrUndefined(p.labelName);
            const after = stringOrUndefined(p.after);
            const variables: Record<string, unknown> = {
              first: cappedPositiveInt(p.first, 50, 100),
              after: after ?? null,
            };
            const variableDefs = ["$first: Int!", "$after: String"];
            const filters: string[] = [];
            if (teamId) {
              variableDefs.push("$teamId: String!");
              filters.push("team: { id: { eq: $teamId } }");
              variables.teamId = teamId;
            }
            if (projectId) {
              variableDefs.push("$projectId: String!");
              filters.push("project: { id: { eq: $projectId } }");
              variables.projectId = projectId;
            }
            if (state) {
              variableDefs.push("$state: String!");
              filters.push("state: { name: { eq: $state } }");
              variables.state = state;
            }
            if (labelName) {
              variableDefs.push("$labelName: String!");
              filters.push("labels: { name: { eq: $labelName } }");
              variables.labelName = labelName;
            }
            const filterBlock = filters.length > 0
              ? `filter: {\n${filters.map((filter) => `                    ${filter}`).join("\n")}\n                  }`
              : "";
            return linearGraphqlBody(`
              query MatrixLinearIssues(${variableDefs.join(", ")}) {
                issues(
                  first: $first
                  after: $after
                  ${filterBlock}
                  orderBy: updatedAt
                ) {
                  nodes {
                    id
                    identifier
                    title
                    description
                    url
                    priority
                    updatedAt
                    assignee { id name displayName }
                    state { id name type color }
                    team { id key name }
                    labels { nodes { id name } }
                    project { id name slugId }
                  }
                  pageInfo { hasNextPage endCursor }
                }
              }
            `, variables);
          },
        },
      },
      create_issue: {
        description: "Create a Linear issue",
        risk: "write",
        params: {
          teamId: { type: "string", required: true },
          title: { type: "string", required: true },
          description: { type: "string" },
          projectId: { type: "string" },
          stateId: { type: "string" },
          assigneeId: { type: "string" },
          priority: { type: "number" },
          labelIds: { type: "array" },
        },
        directApi: {
          method: "POST",
          url: "https://api.linear.app/graphql",
          mapBody: (p) => {
            const labelIds = stringArrayOrUndefined(p.labelIds);
            return linearGraphqlBody(`
              mutation MatrixLinearCreateIssue($input: IssueCreateInput!) {
                issueCreate(input: $input) {
                  success
                  issue { id identifier title url state { id name } labels { nodes { id name } } project { id name slugId } }
                }
              }
            `, {
              input: {
                teamId: String(p.teamId),
                title: String(p.title),
                ...(p.description ? { description: String(p.description) } : {}),
                ...(p.projectId ? { projectId: String(p.projectId) } : {}),
                ...(p.stateId ? { stateId: String(p.stateId) } : {}),
                ...(p.assigneeId ? { assigneeId: String(p.assigneeId) } : {}),
                ...(p.priority !== undefined ? { priority: Number(p.priority) } : {}),
                ...(labelIds && labelIds.length > 0 ? { labelIds } : {}),
              },
            });
          },
        },
      },
      update_issue: {
        description: "Update a Linear issue",
        risk: "write",
        params: {
          issueId: { type: "string", required: true },
          title: { type: "string" },
          description: { type: "string" },
          projectId: { type: "string" },
          stateId: { type: "string" },
          assigneeId: { type: "string" },
          priority: { type: "number" },
        },
        directApi: {
          method: "POST",
          url: "https://api.linear.app/graphql",
          mapBody: (p) => linearGraphqlBody(`
            mutation MatrixLinearUpdateIssue($id: String!, $input: IssueUpdateInput!) {
              issueUpdate(id: $id, input: $input) {
                success
                issue { id identifier title url state { id name } project { id name slugId } }
              }
            }
          `, {
            id: String(p.issueId),
            input: {
              ...(p.title !== undefined ? { title: String(p.title) } : {}),
              ...(p.description !== undefined ? { description: String(p.description) } : {}),
              ...(p.projectId !== undefined ? { projectId: String(p.projectId) } : {}),
              ...(p.stateId !== undefined ? { stateId: String(p.stateId) } : {}),
              ...(p.assigneeId !== undefined ? { assigneeId: String(p.assigneeId) } : {}),
              ...(p.priority !== undefined ? { priority: Number(p.priority) } : {}),
            },
          }),
        },
      },
      comment_issue: {
        description: "Add a comment to a Linear issue",
        risk: "write",
        params: {
          issueId: { type: "string", required: true },
          body: { type: "string", required: true },
        },
        directApi: {
          method: "POST",
          url: "https://api.linear.app/graphql",
          mapBody: (p) => linearGraphqlBody(`
            mutation MatrixLinearCommentIssue($input: CommentCreateInput!) {
              commentCreate(input: $input) {
                success
                comment { id body createdAt issue { id identifier title } }
              }
            }
          `, {
            input: {
              issueId: String(p.issueId),
              body: String(p.body),
            },
          }),
        },
      },
      create_workflow_state: {
        description: "Create a Linear workflow state for Symphony",
        risk: "write",
        params: {
          teamId: { type: "string", required: true },
          name: { type: "string", required: true },
          color: { type: "string", required: true },
          type: { type: "string" },
        },
        directApi: {
          method: "POST",
          url: "https://api.linear.app/graphql",
          mapBody: (p) => linearGraphqlBody(`
            mutation MatrixLinearCreateWorkflowState($input: WorkflowStateCreateInput!) {
              workflowStateCreate(input: $input) {
                success
                workflowState { id name type color team { id key name } }
              }
            }
          `, {
            input: {
              teamId: String(p.teamId),
              name: String(p.name),
              color: String(p.color),
              type: p.type ? String(p.type) : "started",
            },
          }),
        },
      },
    },
  },

  slack: {
    id: "slack",
    name: "Slack",
    category: "communication",
    pipedreamApp: "slack",
    icon: "message-square",
    logoUrl: `${LOGO_BASE}/slack/logo/48`,
    // Slack-specific note: Slack's Web API accepts both
    // application/x-www-form-urlencoded (the historical default) and
    // application/json bodies. Pipedream's proxy forwards JSON cleanly, so
    // we use POST + JSON body for all write actions. Read actions use GET
    // with query params, which is the standard idiom Slack uses for
    // conversations.list etc. Channel param accepts either a channel ID (C...)
    // or a `#channelname` string -- Slack resolves both.
    actions: {
      // Slack Web API: chat.postMessage. JSON body works as long as the
      // token is passed via Authorization header (Pipedream's proxy handles
      // that). Channel can be either a channel ID (C012AB34) or a public
      // channel name like "#general" -- Slack resolves both.
      send_message: {
        description: "Send a message to a channel",
        risk: "write",
        params: {
          channel: { type: "string", required: true },
          text: { type: "string", required: true },
        },
        directApi: {
          method: "POST",
          url: "https://slack.com/api/chat.postMessage",
          mapBody: (p) => ({
            channel: String(p.channel),
            text: String(p.text),
          }),
        },
      },
      list_channels: {
        description: "List a page of channels; continue with response_metadata.next_cursor",
        risk: "read",
        paramsSchema: listValidation.channels,
        params: {
          cursor: { type: "string" },
          limit: { type: "number" },
        },
        directApi: {
          method: "GET",
          url: "https://slack.com/api/conversations.list",
          mapParams: (p) => ({
            ...(p.cursor !== undefined ? { cursor: String(p.cursor) } : {}),
            limit: p.limit ? String(p.limit) : "100",
            exclude_archived: "true",
            types: "public_channel,private_channel",
          }),
        },
      },
      list_messages: {
        description: "List a page of channel messages; continue with response_metadata.next_cursor",
        risk: "read",
        paramsSchema: listValidation.messages,
        params: {
          cursor: { type: "string" },
          channel: { type: "string", required: true },
          limit: { type: "number" },
        },
        directApi: {
          method: "GET",
          url: "https://slack.com/api/conversations.history",
          mapParams: (p) => ({
            ...(p.cursor !== undefined ? { cursor: String(p.cursor) } : {}),
            channel: String(p.channel),
            limit: p.limit ? String(p.limit) : "20",
          }),
        },
      },
      // search.messages requires a Slack user token (not a bot token). When
      // connected via Pipedream's Slack OAuth, the token type is determined
      // by the connect flow's scope set. If the user gets `not_allowed_token_type`,
      // they need to reconnect with `search:read` user-scope.
      search: {
        description: "Search messages",
        risk: "read",
        paramsSchema: listValidation.search,
        params: {
          page: { type: "number" },
          count: { type: "number" },
          query: { type: "string", required: true },
        },
        directApi: {
          method: "GET",
          url: "https://slack.com/api/search.messages",
          mapParams: (p) => ({
            ...(p.page !== undefined ? { page: String(p.page) } : {}),
            ...(p.count !== undefined ? { count: String(p.count) } : {}),
            query: String(p.query),
          }),
        },
      },
      // reactions.add. The `name` field is the emoji shortcode without
      // colons -- ":thumbsup:" should be passed as "thumbsup".
      react: {
        description: "Add a reaction to a message (emoji name without colons)",
        risk: "write",
        params: {
          channel: { type: "string", required: true },
          timestamp: { type: "string", required: true },
          emoji: { type: "string", required: true },
        },
        directApi: {
          method: "POST",
          url: "https://slack.com/api/reactions.add",
          mapBody: (p) => ({
            channel: String(p.channel),
            timestamp: String(p.timestamp),
            name: String(p.emoji).replace(/^:|:$/g, ""),
          }),
        },
      },
    },
  },

  discord: {
    id: "discord",
    name: "Discord",
    category: "communication",
    pipedreamApp: "discord",
    icon: "message-circle",
    logoUrl: `${LOGO_BASE}/discord/logo/48`,
    // Discord-specific note: most "user OAuth" scopes are read-only. Listing
    // a server's channels and reading channel messages technically need a
    // Bot token with the appropriate gateway intent enabled at the Discord
    // app level. Pipedream's Discord connect flow can issue either depending
    // on the configured app type. If callers see `403 Missing Access`, the
    // connected account is OAuth-only and they need to use the bot variant.
    // Discord IDs (snowflakes) are numeric strings; we validate to refuse
    // path-injection attempts.
    actions: {
      // Discord REST: POST /channels/{channel.id}/messages. Requires the bot
      // to have SEND_MESSAGES permission on the channel. Snowflake is
      // strictly validated before interpolation.
      send_message: {
        description: "Send a message to a channel",
        risk: "write",
        params: {
          channelId: { type: "string", required: true },
          content: { type: "string", required: true },
        },
        directApi: {
          method: "POST",
          url: (p) =>
            `https://discord.com/api/v10/channels/${encodeDiscordSnowflake(p.channelId)}/messages`,
          mapBody: (p) => ({ content: String(p.content) }),
        },
      },
      // GET /users/@me/guilds returns the list of servers (guilds) the
      // authenticated user is a member of. Works with the standard `guilds`
      // OAuth scope.
      list_servers: {
        description: "List servers the bot is in",
        risk: "read",
        paramsSchema: listValidation.servers,
        params: {
          before: { type: "string" },
          after: { type: "string" },
          limit: { type: "number" },
        },
        directApi: {
          method: "GET",
          url: "https://discord.com/api/v10/users/@me/guilds",
          mapParams: (p) => ({
            ...(p.before !== undefined ? { before: String(p.before) } : {}),
            ...(p.after !== undefined ? { after: String(p.after) } : {}),
            ...(p.limit !== undefined ? { limit: String(p.limit) } : {}),
          }),
        },
      },
      // GET /guilds/{guild.id}/channels. Requires bot membership with
      // VIEW_CHANNEL permission.
      list_channels: {
        description: "List channels in a server",
        risk: "read",
        params: {
          serverId: { type: "string", required: true },
        },
        directApi: {
          method: "GET",
          url: (p) =>
            `https://discord.com/api/v10/guilds/${encodeDiscordSnowflake(p.serverId)}/channels`,
        },
      },
      // GET /channels/{channel.id}/messages. Returns most recent first.
      list_messages: {
        description: "List messages in a channel",
        risk: "read",
        paramsSchema: listValidation.discordMessages,
        params: {
          before: { type: "string" },
          after: { type: "string" },
          channelId: { type: "string", required: true },
          limit: { type: "number" },
        },
        directApi: {
          method: "GET",
          url: (p) =>
            `https://discord.com/api/v10/channels/${encodeDiscordSnowflake(p.channelId)}/messages`,
          mapParams: (p) => ({
            ...(p.before !== undefined ? { before: String(p.before) } : {}),
            ...(p.after !== undefined ? { after: String(p.after) } : {}),
            limit: p.limit ? String(Math.min(100, Number(p.limit))) : "20",
          }),
        },
      },
    },
  },
  ...EXPANSION_SERVICE_REGISTRY,
});

export function getService(id: string): ServiceDefinition | undefined {
  return SERVICE_REGISTRY[id];
}

export function listServices(): ServiceDefinition[] {
  return Object.values(SERVICE_REGISTRY);
}

export function getAction(
  serviceId: string,
  actionId: string,
): ServiceAction | undefined {
  const service = SERVICE_REGISTRY[serviceId];
  if (!service) return undefined;
  return service.actions[actionId];
}

export function validateIntegrationManifest(
  manifest: { integrations?: { required?: string[]; optional?: string[] } },
): { valid: boolean; missing: string[] } {
  const missing: string[] = [];
  for (const ref of manifest.integrations?.required ?? []) {
    const [serviceId] = ref.split(".");
    if (!getService(serviceId)) missing.push(ref);
  }
  return { valid: missing.length === 0, missing };
}

export async function discoverComponentKeys(
  pipedream: PipedreamConnectClient,
): Promise<{ total: number; matched: number; errors: number }> {
  let total = 0;
  let matched = 0;
  let errors = 0;

  const services = listServices();

  // Collect all discoveries first, then apply atomically to avoid
  // concurrent requests seeing partially-mutated registry state.
  const pending: Array<{ actionDef: ServiceAction; key: string | undefined }> = [];

  for (const service of services) {
    try {
      if (service.connectorKind !== "pipedream" || !service.pipedreamApp) continue;
      const actions = await pipedream.discoverActions(service.pipedreamApp);
      const keySet = new Map(actions.map((a) => [a.key, a]));

      for (const [actionId, actionDef] of Object.entries(service.actions)) {
        total++;
        const hyphenated = actionId.replace(/_/g, "-");
        const candidateKey = `${service.pipedreamApp}-${hyphenated}`;

        if (keySet.has(candidateKey)) {
          pending.push({ actionDef, key: candidateKey });
          matched++;
        } else {
          pending.push({ actionDef, key: undefined });
        }
      }
    } catch (err) {
      errors++;
      if (errors === 1) {
        const msg = err instanceof Error ? err.message : String(err);
        const isPlan = msg.includes("not available on your current plan");
        if (isPlan) {
          console.warn("[registry] Actions API requires a paid Pipedream plan. Falling back to proxy for all services.");
          break;
        }
        console.error(`[registry] discoverComponentKeys failed for ${service.id}:`, msg);
      }
    }
  }

  // Apply all mutations at once
  for (const { actionDef, key } of pending) {
    actionDef.componentKey = key;
  }

  return { total, matched, errors };
}
