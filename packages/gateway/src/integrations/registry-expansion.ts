import type { IntegrationActionRisk, ServiceAction, ServiceDefinition } from "./types.js";

const LOGO_BASE = "https://pipedream.com/s.v0";
const NOTION_HEADERS = Object.freeze({ "Notion-Version": "2022-06-28" });

function cappedPositiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

type ExpansionAction = Omit<ServiceAction, "risk"> & { risk: IntegrationActionRisk };
type ExpansionService = Omit<ServiceDefinition, "actions" | "connectorKind"> & {
  connectorKind?: ServiceDefinition["connectorKind"];
  actions: Record<string, ExpansionAction>;
};

export const EXPANSION_SERVICE_REGISTRY: Record<string, ExpansionService> = {
  google_docs: {
    id: "google_docs",
    name: "Google Docs",
    category: "google",
    pipedreamApp: "google_docs",
    icon: "file-text",
    logoUrl: `${LOGO_BASE}/google_docs/logo/48`,
    actions: {
      get_document: {
        description: "Get a Google document by ID",
        risk: "read",
        params: { documentId: { type: "string", required: true } },
        directApi: {
          method: "GET",
          url: (p) => `https://docs.googleapis.com/v1/documents/${encodeURIComponent(String(p.documentId))}`,
        },
      },
      create_document: {
        description: "Create a Google document",
        risk: "write",
        params: { title: { type: "string", required: true } },
        directApi: {
          method: "POST",
          url: "https://docs.googleapis.com/v1/documents",
          mapBody: (p) => ({ title: String(p.title) }),
        },
      },
      batch_update_document: {
        description: "Apply a batch of updates to a Google document",
        risk: "write",
        params: {
          documentId: { type: "string", required: true },
          requests: { type: "array", required: true },
        },
        directApi: {
          method: "POST",
          url: (p) => `https://docs.googleapis.com/v1/documents/${encodeURIComponent(String(p.documentId))}:batchUpdate`,
          mapBody: (p) => ({ requests: p.requests }),
        },
      },
    },
  },

  notion: {
    id: "notion",
    name: "Notion",
    category: "productivity",
    pipedreamApp: "notion",
    icon: "notebook",
    logoUrl: `${LOGO_BASE}/notion/logo/48`,
    actions: {
      search: {
        description: "Search pages and databases",
        risk: "read",
        params: { query: { type: "string" }, filter: { type: "object" }, pageSize: { type: "number" } },
        directApi: {
          method: "POST",
          url: "https://api.notion.com/v1/search",
          staticHeaders: NOTION_HEADERS,
          mapBody: (p) => ({
            ...(p.query ? { query: String(p.query) } : {}),
            ...(p.filter && typeof p.filter === "object" ? { filter: p.filter } : {}),
            ...(p.pageSize ? { page_size: cappedPositiveInt(p.pageSize, 20, 100) } : {}),
          }),
        },
      },
      get_page: {
        description: "Get a Notion page",
        risk: "read",
        params: { pageId: { type: "string", required: true } },
        directApi: {
          method: "GET",
          url: (p) => `https://api.notion.com/v1/pages/${encodeURIComponent(String(p.pageId))}`,
          staticHeaders: NOTION_HEADERS,
        },
      },
      query_database: {
        description: "Query a Notion database",
        risk: "read",
        params: { databaseId: { type: "string", required: true }, filter: { type: "object" }, sorts: { type: "array" } },
        directApi: {
          method: "POST",
          url: (p) => `https://api.notion.com/v1/databases/${encodeURIComponent(String(p.databaseId))}/query`,
          staticHeaders: NOTION_HEADERS,
          mapBody: (p) => ({
            ...(p.filter && typeof p.filter === "object" ? { filter: p.filter } : {}),
            ...(Array.isArray(p.sorts) ? { sorts: p.sorts } : {}),
          }),
        },
      },
      create_page: {
        description: "Create a Notion page",
        risk: "write",
        params: {
          parent: { type: "object", required: true },
          properties: { type: "object", required: true },
          children: { type: "array" },
        },
        directApi: {
          method: "POST",
          url: "https://api.notion.com/v1/pages",
          staticHeaders: NOTION_HEADERS,
          mapBody: (p) => ({ parent: p.parent, properties: p.properties, ...(p.children ? { children: p.children } : {}) }),
        },
      },
      update_page: {
        description: "Update a Notion page",
        risk: "write",
        params: { pageId: { type: "string", required: true }, properties: { type: "object", required: true } },
        directApi: {
          method: "PATCH",
          url: (p) => `https://api.notion.com/v1/pages/${encodeURIComponent(String(p.pageId))}`,
          staticHeaders: NOTION_HEADERS,
          mapBody: (p) => ({ properties: p.properties }),
        },
      },
      append_blocks: {
        description: "Append content blocks to a Notion page or block",
        risk: "write",
        params: { blockId: { type: "string", required: true }, children: { type: "array", required: true } },
        directApi: {
          method: "PATCH",
          url: (p) => `https://api.notion.com/v1/blocks/${encodeURIComponent(String(p.blockId))}/children`,
          staticHeaders: NOTION_HEADERS,
          mapBody: (p) => ({ children: p.children }),
        },
      },
    },
  },

  figma: {
    id: "figma",
    name: "Figma",
    category: "design",
    pipedreamApp: "figma",
    icon: "figma",
    logoUrl: `${LOGO_BASE}/figma/logo/48`,
    actions: {
      get_file: {
        description: "Get a Figma file",
        risk: "read",
        params: { fileKey: { type: "string", required: true }, depth: { type: "number" } },
        directApi: {
          method: "GET",
          url: (p) => `https://api.figma.com/v1/files/${encodeURIComponent(String(p.fileKey))}`,
          mapParams: (p): Record<string, string> => p.depth
            ? { depth: String(cappedPositiveInt(p.depth, 1, 10)) }
            : {},
        },
      },
      get_nodes: {
        description: "Get selected nodes from a Figma file",
        risk: "read",
        params: { fileKey: { type: "string", required: true }, ids: { type: "array", required: true } },
        directApi: {
          method: "GET",
          url: (p) => `https://api.figma.com/v1/files/${encodeURIComponent(String(p.fileKey))}/nodes`,
          mapParams: (p) => ({ ids: (p.ids as unknown[]).map(String).join(",") }),
        },
      },
      list_comments: {
        description: "List comments on a Figma file",
        risk: "read",
        params: { fileKey: { type: "string", required: true } },
        directApi: {
          method: "GET",
          url: (p) => `https://api.figma.com/v1/files/${encodeURIComponent(String(p.fileKey))}/comments`,
        },
      },
      post_comment: {
        description: "Post a comment on a Figma file",
        risk: "write",
        params: { fileKey: { type: "string", required: true }, message: { type: "string", required: true }, clientMeta: { type: "object" } },
        directApi: {
          method: "POST",
          url: (p) => `https://api.figma.com/v1/files/${encodeURIComponent(String(p.fileKey))}/comments`,
          mapBody: (p) => ({ message: String(p.message), ...(p.clientMeta ? { client_meta: p.clientMeta } : {}) }),
        },
      },
    },
  },

  posthog: {
    id: "posthog",
    name: "PostHog",
    category: "analytics",
    pipedreamApp: "posthog",
    icon: "chart",
    logoUrl: `${LOGO_BASE}/posthog/logo/48`,
    actions: {
      list_projects: { description: "List PostHog projects", risk: "read", params: {} },
      list_insights: { description: "List insights in a PostHog project", risk: "read", params: { projectId: { type: "number", required: true }, limit: { type: "number" } } },
      get_insight: { description: "Get a PostHog insight", risk: "read", params: { projectId: { type: "number", required: true }, insightId: { type: "number", required: true } } },
      query: { description: "Run a read-only PostHog query", risk: "read", params: { projectId: { type: "number", required: true }, query: { type: "object", required: true } } },
    },
  },

  jira: {
    id: "jira",
    name: "Jira",
    category: "developer",
    pipedreamApp: "jira",
    icon: "check-list",
    logoUrl: `${LOGO_BASE}/jira/logo/48`,
    actions: {
      list_projects: { description: "List Jira projects", risk: "read", params: { maxResults: { type: "number" } } },
      search_issues: { description: "Search Jira issues with JQL", risk: "read", params: { jql: { type: "string", required: true }, maxResults: { type: "number" } } },
      get_issue: { description: "Get a Jira issue", risk: "read", params: { issueKey: { type: "string", required: true } } },
      create_issue: { description: "Create a Jira issue", risk: "write", params: { projectKey: { type: "string", required: true }, issueType: { type: "string", required: true }, summary: { type: "string", required: true }, description: { type: "object" } } },
      update_issue: { description: "Update a Jira issue", risk: "write", params: { issueKey: { type: "string", required: true }, fields: { type: "object", required: true } } },
      add_comment: { description: "Add a comment to a Jira issue", risk: "write", params: { issueKey: { type: "string", required: true }, body: { type: "object", required: true } } },
    },
  },

  stripe: {
    id: "stripe",
    name: "Stripe",
    category: "finance",
    pipedreamApp: "stripe",
    icon: "credit-card",
    logoUrl: `${LOGO_BASE}/stripe/logo/48`,
    actions: {
      list_customers: { description: "List Stripe customers using a restricted read-only key", risk: "read", params: { limit: { type: "number" } }, directApi: { method: "GET", url: "https://api.stripe.com/v1/customers", mapParams: (p) => ({ limit: String(cappedPositiveInt(p.limit, 10, 100)) }) } },
      get_customer: { description: "Get a Stripe customer", risk: "read", params: { customerId: { type: "string", required: true } }, directApi: { method: "GET", url: (p) => `https://api.stripe.com/v1/customers/${encodeURIComponent(String(p.customerId))}` } },
      list_subscriptions: { description: "List Stripe subscriptions", risk: "read", params: { customerId: { type: "string" }, limit: { type: "number" } }, directApi: { method: "GET", url: "https://api.stripe.com/v1/subscriptions", mapParams: (p) => ({ ...(p.customerId ? { customer: String(p.customerId) } : {}), limit: String(cappedPositiveInt(p.limit, 10, 100)) }) } },
      list_invoices: { description: "List Stripe invoices", risk: "read", params: { customerId: { type: "string" }, limit: { type: "number" } }, directApi: { method: "GET", url: "https://api.stripe.com/v1/invoices", mapParams: (p) => ({ ...(p.customerId ? { customer: String(p.customerId) } : {}), limit: String(cappedPositiveInt(p.limit, 10, 100)) }) } },
      list_payment_intents: { description: "List Stripe payment intents", risk: "read", params: { customerId: { type: "string" }, limit: { type: "number" } }, directApi: { method: "GET", url: "https://api.stripe.com/v1/payment_intents", mapParams: (p) => ({ ...(p.customerId ? { customer: String(p.customerId) } : {}), limit: String(cappedPositiveInt(p.limit, 10, 100)) }) } },
      get_balance: { description: "Get the Stripe account balance", risk: "read", params: {}, directApi: { method: "GET", url: "https://api.stripe.com/v1/balance" } },
    },
  },

  granola: {
    id: "granola",
    name: "Granola",
    category: "productivity",
    connectorKind: "mcp_preset",
    mcpPreset: { url: "https://mcp.granola.ai/mcp", authMode: "oauth" },
    icon: "note",
    logoUrl: "",
    actions: {
      list_notes: { description: "List Granola meeting notes", risk: "read", params: { query: { type: "string" }, limit: { type: "number" } } },
      get_note: { description: "Get a Granola note, optionally including its transcript", risk: "read", params: { noteId: { type: "string", required: true }, includeTranscript: { type: "boolean" } } },
    },
  },
};
