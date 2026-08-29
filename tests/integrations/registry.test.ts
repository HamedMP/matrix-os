import { describe, it, expect, vi } from "vitest";
import {
  SERVICE_REGISTRY,
  getService,
  listServices,
  getAction,
  validateIntegrationManifest,
  discoverComponentKeys,
} from "../../packages/gateway/src/integrations/registry.js";
import type { PipedreamConnectClient } from "../../packages/gateway/src/integrations/pipedream.js";

describe("Service Registry", () => {
  it("has the 14-service managed catalog", () => {
    expect(listServices()).toHaveLength(14);
    expect(Object.keys(SERVICE_REGISTRY)).toHaveLength(14);
  });

  it("returns service by id", () => {
    const gmail = getService("gmail");
    expect(gmail).toBeDefined();
    expect(gmail!.name).toBe("Gmail");
    expect(gmail!.category).toBe("google");
    expect(gmail!.pipedreamApp).toBe("gmail");
  });

  it("returns undefined for unknown service", () => {
    expect(getService("nonexistent")).toBeUndefined();
  });

  it("lists actions for gmail", () => {
    const gmail = getService("gmail");
    expect(gmail).toBeDefined();
    const actionIds = Object.keys(gmail!.actions);
    expect(actionIds).toContain("list_messages");
    expect(actionIds).toContain("send_email");
    expect(actionIds).toContain("get_message");
    expect(actionIds).toContain("search");
    expect(actionIds).toContain("list_labels");
  });

  it("getAction returns action by service and action id", () => {
    const action = getAction("gmail", "send_email");
    expect(action).toBeDefined();
    expect(action!.description).toBeDefined();
    expect(action!.params.to).toEqual({
      type: "string",
      required: true,
    });
    expect(action!.params.subject).toEqual({
      type: "string",
      required: true,
    });
    expect(action!.params.body).toEqual({
      type: "string",
      required: true,
    });
  });

  it("getAction returns undefined for unknown action", () => {
    expect(getAction("gmail", "nonexistent")).toBeUndefined();
  });

  it("getAction returns undefined for unknown service", () => {
    expect(getAction("nonexistent", "send_email")).toBeUndefined();
  });

  it("all services have required fields", () => {
    for (const service of listServices()) {
      expect(service.id).toBeTruthy();
      expect(service.name).toBeTruthy();
      expect(service.category).toBeTruthy();
      expect(["pipedream", "mcp_preset"]).toContain(service.connectorKind);
      if (service.connectorKind === "pipedream") {
        expect(service.pipedreamApp).toBeTruthy();
      }
      expect(service.icon).toBeTruthy();
      expect(Object.keys(service.actions).length).toBeGreaterThan(0);
      for (const action of Object.values(service.actions)) {
        expect(["read", "write", "destructive"]).toContain(action.risk);
      }
    }
  });

  it("contains the seven expansion services with stable action contracts", () => {
    const expected: Record<string, { read: string[]; write: string[] }> = {
      google_docs: {
        read: ["get_document"],
        write: ["create_document", "batch_update_document"],
      },
      notion: {
        read: ["search", "get_page", "query_database"],
        write: ["create_page", "update_page", "append_blocks"],
      },
      figma: {
        read: ["get_file", "get_nodes", "list_comments"],
        write: ["post_comment"],
      },
      posthog: {
        read: ["list_projects", "list_insights", "get_insight", "query"],
        write: [],
      },
      jira: {
        read: ["list_projects", "search_issues", "get_issue"],
        write: ["create_issue", "update_issue", "add_comment"],
      },
      stripe: {
        read: [
          "list_customers",
          "get_customer",
          "list_subscriptions",
          "list_invoices",
          "list_payment_intents",
          "get_balance",
        ],
        write: [],
      },
      granola: {
        read: ["list_notes", "get_note"],
        write: [],
      },
    };

    for (const [serviceId, contract] of Object.entries(expected)) {
      const service = getService(serviceId);
      expect(service, serviceId).toBeDefined();
      expect(Object.keys(service!.actions)).toEqual([
        ...contract.read,
        ...contract.write,
      ]);
      for (const action of contract.read) {
        expect(service!.actions[action]!.risk).toBe("read");
      }
      for (const action of contract.write) {
        expect(service!.actions[action]!.risk).toBe("write");
      }
    }

    expect(getService("granola")).toMatchObject({
      connectorKind: "mcp_preset",
      mcpPreset: { url: "https://mcp.granola.ai/mcp", authMode: "oauth" },
    });
  });

  it("keeps Stripe, PostHog, and Granola strictly read-only", () => {
    for (const serviceId of ["stripe", "posthog", "granola"]) {
      const actions = Object.values(getService(serviceId)!.actions);
      expect(actions.every((action) => action.risk === "read"), serviceId).toBe(true);
    }
  });

  it("uses only compile-time static header names", () => {
    const notion = getService("notion")!;
    for (const action of Object.values(notion.actions)) {
      expect(action.directApi?.staticHeaders).toEqual({
        "Notion-Version": "2022-06-28",
      });
      expect(action.params).not.toHaveProperty("headers");
    }
  });

  it("contains all 7 expected services", () => {
    const ids = listServices().map((s) => s.id);
    expect(ids).toContain("gmail");
    expect(ids).toContain("google_calendar");
    expect(ids).toContain("google_drive");
    expect(ids).toContain("github");
    expect(ids).toContain("linear");
    expect(ids).toContain("slack");
    expect(ids).toContain("discord");
  });

  it("exposes bounded Linear project, issue, workflow, and comment actions", () => {
    const linear = getService("linear");
    expect(linear).toBeDefined();
    expect(linear!.name).toBe("Linear");
    expect(linear!.category).toBe("developer");
    expect(linear!.pipedreamApp).toBe("linear");

    const actionIds = Object.keys(linear!.actions);
    expect(actionIds).toEqual(expect.arrayContaining([
      "viewer",
      "list_teams",
      "list_projects",
      "list_workflow_states",
      "list_issues",
      "create_issue",
      "update_issue",
      "comment_issue",
      "create_workflow_state",
    ]));

    expect(getAction("linear", "create_issue")!.directApi).toMatchObject({
      method: "POST",
      url: "https://api.linear.app/graphql",
    });
    expect(getAction("linear", "graphql")).toBeUndefined();
  });

  it("does not register destructive or arbitrary-provider escape-hatch actions", () => {
    expect(getAction("google_calendar", "delete_event")).toBeUndefined();
    expect(getAction("linear", "graphql")).toBeUndefined();
    for (const service of listServices()) {
      expect(Object.values(service.actions).every((action) => action.risk !== "destructive")).toBe(true);
    }
  });

  describe("validateIntegrationManifest", () => {
    it("returns valid for known services", () => {
      const result = validateIntegrationManifest({
        integrations: { required: ["gmail", "slack"] },
      });
      expect(result.valid).toBe(true);
      expect(result.missing).toEqual([]);
    });

    it("returns invalid for unknown services", () => {
      const result = validateIntegrationManifest({
        integrations: { required: ["gmail", "salesforce"] },
      });
      expect(result.valid).toBe(false);
      expect(result.missing).toEqual(["salesforce"]);
    });

    it("handles dotted service.action refs", () => {
      const result = validateIntegrationManifest({
        integrations: { required: ["gmail.send_email"] },
      });
      expect(result.valid).toBe(true);
    });

    it("returns valid for empty manifest", () => {
      expect(validateIntegrationManifest({}).valid).toBe(true);
      expect(validateIntegrationManifest({ integrations: {} }).valid).toBe(true);
      expect(validateIntegrationManifest({ integrations: { required: [] } }).valid).toBe(true);
    });

    it("ignores optional services for validity", () => {
      const result = validateIntegrationManifest({
        integrations: { optional: ["nonexistent"] },
      });
      expect(result.valid).toBe(true);
    });
  });

  describe("discoverComponentKeys", () => {
    function mockPipedream(actionsByApp: Record<string, Array<{ key: string; name: string; description?: string }>>): PipedreamConnectClient {
      return {
        createConnectToken: vi.fn(),
        getOAuthUrl: vi.fn(),
        callAction: vi.fn(),
        revokeAccount: vi.fn(),
        listAccounts: vi.fn(),
        getAppInfo: vi.fn(),
        discoverActions: vi.fn().mockImplementation(async (appSlug: string) => {
          return actionsByApp[appSlug] ?? [];
        }),
        runAction: vi.fn(),
      };
    }

    it("matches component keys to registry actions by pattern", async () => {
      const pd = mockPipedream({
        gmail: [
          { key: "gmail-send-email", name: "Send Email" },
          { key: "gmail-list-messages", name: "List Messages" },
          { key: "gmail-get-message", name: "Get Message" },
          { key: "gmail-search", name: "Search" },
          { key: "gmail-list-labels", name: "List Labels" },
          { key: "gmail-other-action", name: "Some other action" },
        ],
        google_calendar: [
          { key: "google_calendar-list-events", name: "List Events" },
          { key: "google_calendar-create-event", name: "Create Event" },
        ],
      });

      const stats = await discoverComponentKeys(pd);

      const gmail = getService("gmail")!;
      expect(gmail.actions.send_email.componentKey).toBe("gmail-send-email");
      expect(gmail.actions.list_messages.componentKey).toBe("gmail-list-messages");
      expect(gmail.actions.get_message.componentKey).toBe("gmail-get-message");
      expect(gmail.actions.search.componentKey).toBe("gmail-search");
      expect(gmail.actions.list_labels.componentKey).toBe("gmail-list-labels");

      const cal = getService("google_calendar")!;
      expect(cal.actions.list_events.componentKey).toBe("google_calendar-list-events");
      expect(cal.actions.create_event.componentKey).toBe("google_calendar-create-event");

      expect(stats.matched).toBeGreaterThan(0);
      expect(stats.total).toBeGreaterThan(0);
    });

    it("handles API errors gracefully for individual services", async () => {
      const pd = mockPipedream({});
      (pd.discoverActions as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("API down"));

      const stats = await discoverComponentKeys(pd);

      expect(stats.errors).toBeGreaterThan(0);
    });

    it("sets componentKey to undefined when no match found", async () => {
      const pd = mockPipedream({
        gmail: [
          { key: "gmail-completely-different", name: "Something Else" },
        ],
      });

      await discoverComponentKeys(pd);

      const gmail = getService("gmail")!;
      expect(gmail.actions.send_email.componentKey).toBeUndefined();
    });
  });
});
