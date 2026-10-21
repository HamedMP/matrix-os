import { describe, expect, it } from "vitest";
import { createIntegrationRoutes } from "../../packages/gateway/src/integrations/routes.js";
import { POSTHOG_ACTIONS } from "../../packages/gateway/src/integrations/missing-managed-actions.js";
import { describeServiceHandler } from "../../packages/kernel/src/tools/integrations.js";

// Read the example out of the exact tool response an agent receives. A private
// Zod schema alone cannot teach the agent a required nested argument shape.
describe("PostHog insight discovery", () => {
  it("describes a complete valid nested insight query and all bounds to agents", async () => {
    const app = createIntegrationRoutes({ db: {} as never, pipedream: { getAppInfo: async () => null } as never,
      webhookSecret: "test-only", resolveUserId: async () => "owner" });
    const result = await describeServiceHandler({ service: "posthog" }, async () => app.request("/agent-catalog"));
    const text = result.content[0].text;
    const action = text.split("\n").find(line => line.startsWith("- create_insight "));
    expect(action).toBeDefined();
    expect(action).toContain("query (required): object");
    const exampleMatch = /Example: (`\{.*?\}`)/.exec(action!);
    expect(exampleMatch, "agent-visible query parameter must contain a JSON example").not.toBeNull();
    const example: unknown = JSON.parse(exampleMatch![1].slice(1, -1));
    expect(POSTHOG_ACTIONS.create_insight.paramsSchema!.safeParse({ region: "eu", projectId: 1, name: "Page views", query: example }).success).toBe(true);
    expect(action).toContain("InsightVizNode");
    expect(action).toContain("TrendsQuery");
    expect(action).toContain("EventsNode");
    expect(action).toContain("YYYY-MM-DD");
    expect(action).toContain("93 days");
    expect(action).toContain("1–5");
    expect(action).toContain("1–200");
    expect(action).toContain("day|week|month");
    expect(action).toContain("total|dau");
    expect(action).toContain("no extra fields");
  });
  it.each(["private provider token " + "x".repeat(2048), "private provider token\nmore details", { error: "private provider token" }])("omits malformed or oversized parameter descriptions (%#)", async description => {
    const result = await describeServiceHandler({ service: "fixture" }, async () => Response.json([{ id: "fixture", name: "Fixture", actions: {
      get: { risk: "read", params: { id: { type: "string", required: true, description } } },
    } }]));
    expect(result.content[0].text).toContain("id (required): string");
    expect(result.content[0].text).not.toContain("private provider token");
  });

});
