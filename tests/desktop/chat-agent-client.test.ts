import { describe, expect, it, vi } from "vitest";
import { createChatAgentClient } from "../../packages/ui/src/chat-agents/client";

describe("Chat Agent recipe client", () => {
  it("loads recipe capabilities and keeps only bounded display metadata for connections", async () => {
    const request = vi.fn(async (path: string) => path === "/api/chat-agents/recipe-catalog"
      ? {
          enabled: true,
          skills: [
            { id: "matrix-integrations", name: "Matrix integrations", description: "Use connected services." },
            { id: "matrix-personal-daily-brief", name: "Personal Daily Brief", description: "Prepare a daily brief." },
          ],
          services: [{ id: "gmail", name: "Gmail" }, { id: "google_calendar", name: "Google Calendar" }],
        }
      : [{
          service: "gmail",
          account_label: "Work",
          account_email: "work@example.test",
          status: "active",
          access_token: "must-not-reach-ui",
          scopes: ["mail.read"],
        }]);
    const client = createChatAgentClient(request);

    const catalog = await client.recipeCatalog();
    expect(catalog.enabled).toBe(true);
    expect(catalog.services[0]).toEqual({ id: "gmail", name: "Gmail" });
    expect(await client.integrations()).toEqual([{
      service: "gmail", account_label: "Work", account_email: "work@example.test", status: "active",
    }]);
    expect(request.mock.calls.map(([path, method]) => [path, method])).toEqual([
      ["/api/chat-agents/recipe-catalog", "GET"],
      ["/api/integrations", "GET"],
    ]);
  });
});
