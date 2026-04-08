import type { ServiceAction, ServiceDefinition } from "./types.js";
import type { PipedreamConnectClient } from "./pipedream.js";

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

export const SERVICE_REGISTRY: Record<string, ServiceDefinition> = {
  gmail: {
    id: "gmail",
    name: "Gmail",
    category: "google",
    pipedreamApp: "gmail",
    icon: "mail",
    logoUrl: `${LOGO_BASE}/gmail/logo/48`,
    actions: {
      list_messages: {
        description: "List recent email messages",
        params: {
          query: { type: "string" },
          maxResults: { type: "number" },
        },
        directApi: {
          method: "GET",
          url: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
          mapParams: (p) => ({
            ...(p.maxResults ? { maxResults: String(p.maxResults) } : {}),
            ...(p.query ? { q: String(p.query) } : {}),
          }),
        },
      },
      get_message: {
        description: "Get a specific email message by ID",
        params: {
          messageId: { type: "string", required: true },
        },
        directApi: {
          method: "GET",
          url: (p) => `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(String(p.messageId))}?format=full`,
        },
      },
      send_email: {
        description: "Send an email",
        params: {
          to: { type: "string", required: true },
          subject: { type: "string", required: true },
          body: { type: "string", required: true },
          cc: { type: "string" },
        },
      },
      search: {
        description: "Search emails by query",
        params: {
          query: { type: "string", required: true },
          maxResults: { type: "number" },
        },
        directApi: {
          method: "GET",
          url: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
          mapParams: (p) => ({
            q: String(p.query),
            ...(p.maxResults ? { maxResults: String(p.maxResults) } : {}),
          }),
        },
      },
      list_labels: {
        description: "List all email labels",
        params: {},
        directApi: {
          method: "GET",
          url: "https://gmail.googleapis.com/gmail/v1/users/me/labels",
        },
      },
    },
  },

  google_calendar: {
    id: "google_calendar",
    name: "Google Calendar",
    category: "google",
    pipedreamApp: "google_calendar",
    icon: "calendar",
    logoUrl: `${LOGO_BASE}/google_calendar/logo/48`,
    actions: {
      // GCal API: events.list. We always target the user's primary calendar
      // -- multi-calendar support would require a separate `calendarId` param
      // and a /calendars/list call to enumerate.
      list_events: {
        description: "List calendar events",
        params: {
          timeMin: { type: "string" },
          timeMax: { type: "string" },
          maxResults: { type: "number" },
        },
        directApi: {
          method: "GET",
          url: "https://www.googleapis.com/calendar/v3/calendars/primary/events",
          mapParams: (p) => ({
            singleEvents: "true",
            orderBy: "startTime",
            ...(p.timeMin ? { timeMin: String(p.timeMin) } : {}),
            ...(p.timeMax ? { timeMax: String(p.timeMax) } : {}),
            ...(p.maxResults ? { maxResults: String(p.maxResults) } : {}),
          }),
        },
      },
      // GCal API: events.insert. `start`/`end` are RFC3339 strings; we wrap
      // them in dateTime fields. Callers passing a date-only string will get
      // a Google-side validation error -- by design, we don't try to detect
      // and remap to {date: ...} all-day events here.
      create_event: {
        description: "Create a new calendar event",
        params: {
          summary: { type: "string", required: true },
          start: { type: "string", required: true },
          end: { type: "string", required: true },
          description: { type: "string" },
          location: { type: "string" },
        },
        directApi: {
          method: "POST",
          url: "https://www.googleapis.com/calendar/v3/calendars/primary/events",
          mapBody: (p) => ({
            summary: String(p.summary),
            start: { dateTime: String(p.start) },
            end: { dateTime: String(p.end) },
            ...(p.description ? { description: String(p.description) } : {}),
            ...(p.location ? { location: String(p.location) } : {}),
          }),
        },
      },
      // GCal API: events.patch (PATCH, not PUT, so we don't have to send the
      // whole event object). Only fields the caller actually provided are
      // forwarded.
      update_event: {
        description: "Update an existing calendar event",
        params: {
          eventId: { type: "string", required: true },
          summary: { type: "string" },
          start: { type: "string" },
          end: { type: "string" },
        },
        directApi: {
          method: "PATCH",
          url: (p) =>
            `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(String(p.eventId))}`,
          mapBody: (p) => ({
            ...(p.summary !== undefined ? { summary: String(p.summary) } : {}),
            ...(p.start !== undefined ? { start: { dateTime: String(p.start) } } : {}),
            ...(p.end !== undefined ? { end: { dateTime: String(p.end) } } : {}),
          }),
        },
      },
      // GCal API: events.delete. Returns 204 No Content on success.
      delete_event: {
        description: "Delete a calendar event",
        params: {
          eventId: { type: "string", required: true },
        },
        directApi: {
          method: "DELETE",
          url: (p) =>
            `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(String(p.eventId))}`,
        },
      },
    },
  },

  google_drive: {
    id: "google_drive",
    name: "Google Drive",
    category: "google",
    pipedreamApp: "google_drive",
    icon: "hard-drive",
    logoUrl: `${LOGO_BASE}/google_drive/logo/48`,
    actions: {
      // Drive API v3: files.list. Combines optional `query` (free-text name
      // search) and `folderId` (parents containment) into Drive's `q` filter
      // language. If both are absent, returns the user's recent files.
      list_files: {
        description: "List files in Google Drive",
        params: {
          query: { type: "string" },
          maxResults: { type: "number" },
          folderId: { type: "string" },
        },
        directApi: {
          method: "GET",
          url: "https://www.googleapis.com/drive/v3/files",
          mapParams: (p) => {
            const clauses: string[] = [];
            if (p.query) clauses.push(`name contains '${String(p.query).replace(/'/g, "\\'")}'`);
            if (p.folderId) clauses.push(`'${String(p.folderId).replace(/'/g, "\\'")}' in parents`);
            return {
              fields: "files(id,name,mimeType,modifiedTime,size,parents,webViewLink)",
              ...(clauses.length > 0 ? { q: clauses.join(" and ") } : {}),
              ...(p.maxResults ? { pageSize: String(p.maxResults) } : { pageSize: "25" }),
            };
          },
        },
      },
      // Drive API v3: files.get (metadata only -- no alt=media). Returns the
      // standard file metadata fields. For the binary content, the agent
      // would need a separate `download_file` action we haven't shipped.
      get_file: {
        description: "Get file metadata by ID",
        params: {
          fileId: { type: "string", required: true },
        },
        directApi: {
          method: "GET",
          url: (p) =>
            `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(String(p.fileId))}`,
          mapParams: () => ({
            fields: "id,name,mimeType,modifiedTime,createdTime,size,parents,owners,webViewLink",
          }),
        },
      },
      upload_file: {
        description: "Upload a file to Google Drive",
        params: {
          name: { type: "string", required: true },
          content: { type: "string", required: true },
          mimeType: { type: "string" },
          folderId: { type: "string" },
        },
      },
      // Drive API v3: permissions.create. Defaults to role=reader for least
      // privilege; caller can override with `role` (writer, commenter, owner).
      // sendNotificationEmail=false avoids spamming the recipient -- if they
      // want a notification, they can paste the link manually.
      share_file: {
        description: "Share a file with another user",
        params: {
          fileId: { type: "string", required: true },
          email: { type: "string", required: true },
          role: { type: "string" },
        },
        directApi: {
          method: "POST",
          url: (p) =>
            `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(String(p.fileId))}/permissions?sendNotificationEmail=false`,
          mapBody: (p) => ({
            type: "user",
            role: p.role ? String(p.role) : "reader",
            emailAddress: String(p.email),
          }),
        },
      },
    },
  },

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
        params: {
          sort: { type: "string" },
          per_page: { type: "number" },
        },
        directApi: {
          method: "GET",
          url: "https://api.github.com/user/repos",
          mapParams: (p) => ({
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
        params: {
          repo: { type: "string", required: true },
          state: { type: "string" },
        },
        directApi: {
          method: "GET",
          url: (p) => `https://api.github.com/repos/${encodeOwnerRepo(p.repo)}/issues`,
          mapParams: (p) => ({
            state: p.state ? String(p.state) : "open",
          }),
        },
      },
      // GitHub API: POST /repos/{owner}/{repo}/issues. `labels` is a
      // comma-separated string in our params; GitHub wants an array, so we
      // split here. Empty string -> no labels, not a single empty label.
      create_issue: {
        description: "Create a new issue (use owner/repo format)",
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
        params: {
          repo: { type: "string", required: true },
          state: { type: "string" },
        },
        directApi: {
          method: "GET",
          url: (p) => `https://api.github.com/repos/${encodeOwnerRepo(p.repo)}/pulls`,
          mapParams: (p) => ({
            state: p.state ? String(p.state) : "open",
          }),
        },
      },
      // GitHub API: GET /notifications. `all=true` includes already-read; the
      // default is unread only.
      get_notifications: {
        description: "Get notifications",
        params: {
          all: { type: "boolean" },
        },
        directApi: {
          method: "GET",
          url: "https://api.github.com/notifications",
          mapParams: (p) => ({
            all: p.all ? "true" : "false",
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
      send_message: {
        description: "Send a message to a channel",
        params: {
          channel: { type: "string", required: true },
          text: { type: "string", required: true },
        },
      },
      list_channels: {
        description: "List available channels",
        params: {
          limit: { type: "number" },
        },
        directApi: {
          method: "GET",
          url: "https://slack.com/api/conversations.list",
          mapParams: (p) => ({
            limit: p.limit ? String(p.limit) : "100",
            exclude_archived: "true",
            types: "public_channel,private_channel",
          }),
        },
      },
      list_messages: {
        description: "List messages in a channel",
        params: {
          channel: { type: "string", required: true },
          limit: { type: "number" },
        },
        directApi: {
          method: "GET",
          url: "https://slack.com/api/conversations.history",
          mapParams: (p) => ({
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
        params: {
          query: { type: "string", required: true },
        },
        directApi: {
          method: "GET",
          url: "https://slack.com/api/search.messages",
          mapParams: (p) => ({
            query: String(p.query),
          }),
        },
      },
      // reactions.add. The `name` field is the emoji shortcode without
      // colons -- ":thumbsup:" should be passed as "thumbsup".
      react: {
        description: "Add a reaction to a message (emoji name without colons)",
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
      send_message: {
        description: "Send a message to a channel",
        params: {
          channelId: { type: "string", required: true },
          content: { type: "string", required: true },
        },
      },
      // GET /users/@me/guilds returns the list of servers (guilds) the
      // authenticated user is a member of. Works with the standard `guilds`
      // OAuth scope.
      list_servers: {
        description: "List servers the bot is in",
        params: {},
        directApi: {
          method: "GET",
          url: "https://discord.com/api/v10/users/@me/guilds",
        },
      },
      // GET /guilds/{guild.id}/channels. Requires bot membership with
      // VIEW_CHANNEL permission.
      list_channels: {
        description: "List channels in a server",
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
        params: {
          channelId: { type: "string", required: true },
          limit: { type: "number" },
        },
        directApi: {
          method: "GET",
          url: (p) =>
            `https://discord.com/api/v10/channels/${encodeDiscordSnowflake(p.channelId)}/messages`,
          mapParams: (p) => ({
            limit: p.limit ? String(Math.min(100, Number(p.limit))) : "20",
          }),
        },
      },
    },
  },
};

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
