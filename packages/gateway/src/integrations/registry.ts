import type { ServiceAction, ServiceDefinition } from "./types.js";

const LOGO_BASE = "https://pipedream.com/s.v0";

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
      },
      get_message: {
        description: "Get a specific email message by ID",
        params: {
          messageId: { type: "string", required: true },
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
      },
      list_labels: {
        description: "List all email labels",
        params: {},
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
      list_events: {
        description: "List calendar events",
        params: {
          timeMin: { type: "string" },
          timeMax: { type: "string" },
          maxResults: { type: "number" },
        },
      },
      create_event: {
        description: "Create a new calendar event",
        params: {
          summary: { type: "string", required: true },
          start: { type: "string", required: true },
          end: { type: "string", required: true },
          description: { type: "string" },
          location: { type: "string" },
        },
      },
      update_event: {
        description: "Update an existing calendar event",
        params: {
          eventId: { type: "string", required: true },
          summary: { type: "string" },
          start: { type: "string" },
          end: { type: "string" },
        },
      },
      delete_event: {
        description: "Delete a calendar event",
        params: {
          eventId: { type: "string", required: true },
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
      list_files: {
        description: "List files in Google Drive",
        params: {
          query: { type: "string" },
          maxResults: { type: "number" },
          folderId: { type: "string" },
        },
      },
      get_file: {
        description: "Get file metadata by ID",
        params: {
          fileId: { type: "string", required: true },
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
      share_file: {
        description: "Share a file with another user",
        params: {
          fileId: { type: "string", required: true },
          email: { type: "string", required: true },
          role: { type: "string" },
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
    actions: {
      list_repos: {
        description: "List repositories",
        params: {
          sort: { type: "string" },
          per_page: { type: "number" },
        },
      },
      list_issues: {
        description: "List issues for a repository",
        params: {
          repo: { type: "string", required: true },
          state: { type: "string" },
        },
      },
      create_issue: {
        description: "Create a new issue",
        params: {
          repo: { type: "string", required: true },
          title: { type: "string", required: true },
          body: { type: "string" },
          labels: { type: "string" },
        },
      },
      list_prs: {
        description: "List pull requests for a repository",
        params: {
          repo: { type: "string", required: true },
          state: { type: "string" },
        },
      },
      get_notifications: {
        description: "Get notifications",
        params: {
          all: { type: "boolean" },
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
      },
      list_messages: {
        description: "List messages in a channel",
        params: {
          channel: { type: "string", required: true },
          limit: { type: "number" },
        },
      },
      search: {
        description: "Search messages",
        params: {
          query: { type: "string", required: true },
        },
      },
      react: {
        description: "Add a reaction to a message",
        params: {
          channel: { type: "string", required: true },
          timestamp: { type: "string", required: true },
          emoji: { type: "string", required: true },
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
    actions: {
      send_message: {
        description: "Send a message to a channel",
        params: {
          channelId: { type: "string", required: true },
          content: { type: "string", required: true },
        },
      },
      list_servers: {
        description: "List servers the bot is in",
        params: {},
      },
      list_channels: {
        description: "List channels in a server",
        params: {
          serverId: { type: "string", required: true },
        },
      },
      list_messages: {
        description: "List messages in a channel",
        params: {
          channelId: { type: "string", required: true },
          limit: { type: "number" },
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
