import { describe, expect, it, vi } from "vitest";
import { createChatAgentClient } from "../../packages/ui/src/chat-agents/client";
import { createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat";
import { AppError } from "../../desktop/src/shared/app-error.js";
import { FUNDED_AI_READINESS_TIMEOUTS } from "@matrix-os/contracts";

describe("Chat Agent recipe client", () => {
  it("preserves the safe HTTP status from the desktop transport without leaking its cause", async () => {
    const request = vi.fn().mockRejectedValue(new AppError("server", { httpStatus: 400, cause: new Error("private path") }));
    await expect(createChatAgentClient(request).bots!.recoverManagedCustom!("bot_recover01", { baseRevision: 1 }))
      .rejects.toMatchObject({ status: 400, message: "The request is invalid." });
  });
  it("recovers only the explicit saved Bot revision through the authenticated transport", async () => {
    const response = { agent: { id: "bot_recover01", name: "Existing Bot", avatarSeed: "a".repeat(32), revision: 2, status: "active" },
      chatId: "chat_recover01", operation: "replayed" };
    const request = vi.fn(async () => response);
    const client = createChatAgentClient(request);
    await client.bots!.recoverManagedCustom!("bot_recover01", { baseRevision: 1 });
    expect(request).toHaveBeenCalledExactlyOnceWith("/api/chat-agents/bot_recover01/recover-managed-custom", "POST", { baseRevision: 1 });
    expect(() => client.bots!.recoverManagedCustom!("bot_recover01", { baseRevision: 0 })).toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("preserves the bounded unfinished-recovery projection through library transport parsing", async () => {
    const request = vi.fn(async () => ({ enabled: true, agents: [], managedCustomRecoveries: [{ agentId: "bot_recover01", baseRevision: 1 }] }));
    expect(await createChatAgentClient(request).list()).toMatchObject({ managedCustomRecoveries: [{ agentId: "bot_recover01", baseRevision: 1 }] });
    expect(request).toHaveBeenCalledExactlyOnceWith("/api/chat-agents?includeManagedCustomRecoveries=true", "GET");
  });
  it("requests funding-aware model states through the existing shared transport", async () => {
    const request = vi.fn(async () => createCanonicalProviderCatalogFixture());
    await createChatAgentClient(request).catalog();
    expect(request).toHaveBeenCalledExactlyOnceWith("/api/chat-providers?includeConnectionLabels=true&includeConnectionState=true&includeFundingState=true&includeChatFunding=true", "GET", undefined,
      { timeoutMs: FUNDED_AI_READINESS_TIMEOUTS.rendererRequestMs });
  });
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
