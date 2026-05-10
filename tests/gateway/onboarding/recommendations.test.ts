import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { KyselyPGlite } from "kysely-pglite";
import { createPlatformDb, type PlatformDb } from "../../../packages/gateway/src/platform-db.js";
import { createIntegrationRoutes } from "../../../packages/gateway/src/integrations/routes.js";
import type { PipedreamConnectClient } from "../../../packages/gateway/src/integrations/pipedream.js";
import {
  CODING_AGENT_OPTIONS,
  buildPersonalizedOnboardingPlan,
  type EmailSignal,
} from "../../../packages/gateway/src/onboarding/recommendations.js";

function mockPipedream(overrides?: Partial<PipedreamConnectClient>): PipedreamConnectClient {
  return {
    createConnectToken: vi.fn().mockResolvedValue({ token: "pd_tok_test", expiresAt: "2026-12-31T00:00:00Z", connectLinkUrl: "https://pipedream.com/connect/test?token=pd_tok_test" }),
    getOAuthUrl: vi.fn((url: string, app: string) => `${url}&app=${app}`),
    callAction: vi.fn().mockResolvedValue({ ok: true }),
    discoverActions: vi.fn().mockResolvedValue([]),
    runAction: vi.fn().mockResolvedValue({ exports: {}, ret: {} }),
    proxyGet: vi.fn().mockResolvedValue({}),
    proxyPost: vi.fn().mockResolvedValue({ ok: true }),
    proxyPut: vi.fn().mockResolvedValue({ ok: true }),
    proxyPatch: vi.fn().mockResolvedValue({ ok: true }),
    proxyDelete: vi.fn().mockResolvedValue({ ok: true }),
    revokeAccount: vi.fn().mockResolvedValue(undefined),
    listAccounts: vi.fn().mockResolvedValue([]),
    getAppInfo: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

const todoistEmail: EmailSignal = {
  id: "msg_todoist",
  from: "Todoist <notifications@todoist.com>",
  subject: "Today: Finish onboarding spec",
  snippet: "You have tasks due today in Todoist.",
};

describe("personalized onboarding recommendations", () => {
  it("detects Todoist from email and recommends connecting it plus a Matrix replacement", () => {
    const plan = buildPersonalizedOnboardingPlan({
      emails: [todoistEmail],
      calendarEvents: [],
      connectedServices: ["gmail"],
      userPreferences: {
        includedServices: [],
        excludedServices: [],
        missingServices: [],
        codingAgents: ["claude_code", "codex"],
      },
      aiRecommendations: [],
    });

    expect(plan.detectedServices).toContainEqual(expect.objectContaining({
      id: "todoist",
      name: "Todoist",
      source: "email",
    }));
    expect(plan.recommendations).toContainEqual(expect.objectContaining({
      category: "connection",
      serviceId: "todoist",
      title: expect.stringMatching(/connect todoist/i),
    }));
    expect(plan.recommendations).toContainEqual(expect.objectContaining({
      category: "app",
      serviceId: "todoist",
      matrixReplacement: expect.stringMatching(/tasks/i),
    }));
    expect(plan.codingAgents.map((agent) => agent.id)).toEqual(["claude_code", "codex"]);
    expect(CODING_AGENT_OPTIONS.map((agent) => agent.id)).toEqual([
      "claude_code",
      "codex",
      "hermes",
      "openclaw",
    ]);
  });

  it("honors explicit missing, included, and excluded service preferences", () => {
    const plan = buildPersonalizedOnboardingPlan({
      emails: [todoistEmail],
      calendarEvents: [],
      connectedServices: ["gmail"],
      userPreferences: {
        includedServices: ["Linear"],
        excludedServices: ["todoist"],
        missingServices: ["Raycast"],
        codingAgents: ["openclaw"],
      },
      aiRecommendations: [],
    });

    expect(plan.detectedServices.some((service) => service.id === "todoist")).toBe(false);
    expect(plan.detectedServices).toContainEqual(expect.objectContaining({
      id: "linear",
      source: "user_included",
    }));
    expect(plan.detectedServices).toContainEqual(expect.objectContaining({
      id: "raycast",
      source: "user_missing",
    }));
    expect(plan.codingAgents.map((agent) => agent.id)).toEqual(["openclaw"]);
  });
});

describe("POST /api/integrations/onboarding/recommendations", () => {
  let db: PlatformDb;
  let pglite: InstanceType<typeof KyselyPGlite>;
  let app: Hono;
  let userId: string;
  let pipedream: PipedreamConnectClient;
  let fetchFn: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    pglite = await KyselyPGlite.create();
    db = createPlatformDb({ dialect: pglite.dialect });
    await db.migrate();
    const user = await db.createUser({
      clerkId: "clerk_onboarding_recs",
      handle: "onboarding-recs",
      displayName: "Onboarding Recs",
      email: "recs@example.com",
      containerId: "container_onboarding_recs",
      pipedreamExternalId: "pd_ext_onboarding_recs",
    });
    userId = user.id;
    await db.connectService({
      userId,
      service: "gmail",
      pipedreamAccountId: "pd_acc_gmail",
      accountLabel: "Work Gmail",
      accountEmail: "work@example.com",
      scopes: ["gmail.readonly"],
    });

    pipedream = mockPipedream({
      proxyGet: vi.fn(async ({ url }: { url: string }) => {
        if (url.includes("/users/me/messages/")) {
          return {
            id: "msg_todoist",
            snippet: "You have tasks due today in Todoist.",
            payload: {
              headers: [
                { name: "From", value: "Todoist <notifications@todoist.com>" },
                { name: "Subject", value: "Today: Finish onboarding spec" },
              ],
            },
          };
        }
        if (url.includes("/users/me/messages")) {
          return { messages: [{ id: "msg_todoist" }] };
        }
        return {};
      }),
    });
    fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    recommendations: [
                      {
                        id: "ai-task-routine",
                        category: "routine",
                        title: "AI task review",
                        description: "Review detected Todoist tasks every morning.",
                        serviceId: "todoist",
                        priority: "medium",
                      },
                    ],
                  }),
                },
              ],
            },
          },
        ],
      }),
    });

    const routes = createIntegrationRoutes({
      db,
      pipedream,
      webhookSecret: "whsec_test",
      resolveUserId: async () => userId,
      recommendationAi: {
        apiKey: "gemini-test-key",
        model: "gemini-3.1-flash",
        fetchFn,
      },
    });
    app = new Hono();
    app.route("/api/integrations", routes);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("analyzes Gmail through Pipedream, caps email analysis input, and merges Gemini Flash recommendations", async () => {
    const res = await app.request("/api/integrations/onboarding/recommendations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        maxEmails: 1000,
        codingAgents: ["claude_code", "hermes"],
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();

    expect(pipedream.proxyGet).toHaveBeenCalledWith(expect.objectContaining({
      externalUserId: "pd_ext_onboarding_recs",
      accountId: "pd_acc_gmail",
      url: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      params: expect.objectContaining({ maxResults: "500" }),
    }));
    expect(data.analyzedEmailCount).toBe(1);
    expect(data.maxEmails).toBe(1000);
    expect(data.detectedServices).toContainEqual(expect.objectContaining({ id: "todoist" }));
    expect(data.recommendations).toContainEqual(expect.objectContaining({ id: "ai-task-routine" }));
    expect(fetchFn).toHaveBeenCalledWith(
      expect.stringContaining("/models/gemini-3.1-flash:generateContent"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("falls back to deterministic recommendations when Gemini fails without exposing raw provider errors", async () => {
    fetchFn.mockRejectedValueOnce(new Error("provider secret stack trace"));

    const res = await app.request("/api/integrations/onboarding/recommendations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ codingAgents: ["codex"] }),
    });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain("provider secret stack trace");
    const data = JSON.parse(body);
    expect(data.warnings).toContain("ai_unavailable");
    expect(data.recommendations).toContainEqual(expect.objectContaining({
      serviceId: "todoist",
      category: "connection",
    }));
  });
});
