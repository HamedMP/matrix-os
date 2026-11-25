import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { AgentThreadEventSchema, DEFAULT_NOTIFICATION_PREFERENCES } from "@matrix-os/contracts";
import { createNotificationPreferenceRuntime } from "../../packages/gateway/src/notifications/runtime.js";
import { registerGatewayCodingAgentRoutes } from "../../packages/gateway/src/server/project-routes.js";
import { initializeGatewayChannels } from "../../packages/gateway/src/startup/channels.js";
import { createCodingAgentThreadStore } from "../../packages/gateway/src/coding-agents/thread-store.js";
import { createReviewStore } from "../../packages/gateway/src/review-store.js";
import { createConversationStore } from "../../packages/gateway/src/conversations.js";
import { markAuthContextReady, readPrincipalRuntimeConfig, requireRequestPrincipal } from "../../packages/gateway/src/request-principal.js";

// Real registration -> real HTTP routes -> owner file -> real thread events -> startup-wired bridge.
// Only the final external channel send is intercepted; no replica preference or routing logic.
describe("notification preference production composition", () => {
  it.each([
    { name: "configured owner", env: { MATRIX_USER_ID: "owner_user" }, ownerId: "owner_user" },
    { name: "local-development owner", env: { NODE_ENV: "development" }, ownerId: "default" },
  ])("wires both APIs and the legacy bridge to one store for $name", async ({ env, ownerId }) => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-notification-runtime-"));
    const principalConfig = readPrincipalRuntimeConfig(env);
    const principal = requireRequestPrincipal({ get: () => undefined }, { ...principalConfig, requireAuthContextReady: false });
    const runtime = createNotificationPreferenceRuntime({ homePath, env, reviewStore: createReviewStore({ homePath }) });
    const threads = createCodingAgentThreadStore({ homePath, providers: [{
      providerId: "codex",
      startThread({ thread, nextEventId }) {
        return [AgentThreadEventSchema.parse({
          type: "thread.completed", eventId: nextEventId(), threadId: thread.id,
          occurredAt: new Date().toISOString(), outcome: "completed",
        })];
      },
    }] });
    const app = new Hono();
    app.use("*", async (c, next) => { markAuthContextReady(c); await next(); });
    registerGatewayCodingAgentRoutes(app, {
      service: { getSummary: async () => { throw new Error("not used"); } },
      projects: {
        createProject: async () => { throw new Error("not used"); },
        getProject: async () => { throw new Error("not used"); },
      },
      notificationPreferences: runtime.legacy,
      getPrincipal: c => requireRequestPrincipal(c, principalConfig),
    });
    // No adapters enabled; channel startup and its bridge registration run unchanged.
    const configPath = join(homePath, "system/config.json");
    const initial = await app.request("/api/notifications/preferences");
    expect(initial.status).toBe(200);
    await writeFile(configPath, JSON.stringify({ channels: {} }));
    const channels = initializeGatewayChannels({
      homePath, configPath, codingAgentThreadStore: threads,
      codingAgentNotificationPreferenceStore: runtime.legacy,
      dispatcher: { dispatch: async () => { throw new Error("not used"); } } as Parameters<typeof initializeGatewayChannels>[0]["dispatcher"],
      conversations: createConversationStore(homePath),
      finalizeWithSummary: async () => {}, logBestEffortFailure: (context, error) => { throw new Error(context, { cause: error }); },
      channelStt: async () => { throw new Error("not used"); }, pushTokens: null,
    });
    const send = vi.spyOn(channels.channelManager, "send").mockResolvedValue(undefined);
    const reader = vi.spyOn(runtime.legacy, "isAttentionPushEnabled");
    try {
      if (principal.source === "dev-default") {
        // Matching the fallback's id does not turn a JWT into a trusted local principal.
        await expect(runtime.legacy.preferences.load({ userId: ownerId, source: "jwt" })).rejects.toThrow("runtime owner");
        await expect(runtime.legacy.isAttentionPushEnabled({ ownerId: "other_user", kind: "completed" })).rejects.toThrow("runtime owner");
        reader.mockClear();
      }
      const document = structuredClone(DEFAULT_NOTIFICATION_PREFERENCES);
      document.events.replyFinished = false;
      const saved = await app.request("/api/notifications/preferences", {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(document),
      });
      expect(saved.status).toBe(200);
      const legacyRead = await app.request("/api/coding-agents/notification-preferences");
      expect((await legacyRead.json()).preferences.attentionPush.completed).toBe(false);
      await threads.createThread(principal, { providerId: "codex", prompt: "Run one", clientRequestId: "req_off" });
      await vi.waitFor(() => expect(reader).toHaveResolvedWith(false));
      expect(send).not.toHaveBeenCalled();
      const legacySave = await app.request("/api/coding-agents/notification-preferences", {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ attentionPush: { approval: true, input: true, failed: true, completed: true } }),
      });
      expect(legacySave.status).toBe(200);
      const latest = await app.request("/api/notifications/preferences");
      expect((await latest.json()).preferences).toMatchObject({ revision: 2, events: { replyFinished: true } });
      await threads.createThread(principal, { providerId: "codex", prompt: "Run two", clientRequestId: "req_on" });
      await vi.waitFor(() => expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ownerId, text: "Agent run completed." })));
      // A corrupt owner document blocks sends through the actual bridge failure path.
      await writeFile(join(homePath, "system/notifications.json"), "invalid");
      await threads.createThread(principal, { providerId: "codex", prompt: "Run three", clientRequestId: "req_corrupt" });
      await vi.waitFor(() => expect(reader).toHaveBeenCalledTimes(3));
      await vi.waitFor(() => expect(reader.mock.settledResults[2]?.type).toBe("rejected"));
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      channels.codingAgentAttentionNotifications?.dispose();
      channels.pushAdapter.dispose();
      await channels.channelManager.stop();
      await rm(homePath, { recursive: true, force: true });
    }
  });

  it.each([
    { NODE_ENV: "production" },
    { NODE_ENV: "development", MATRIX_AUTH_TOKEN: "test-token" },
  ])("does not grant a local bridge identity outside the unauthenticated development gate: %j", async env => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-notification-runtime-denied-"));
    try {
      const runtime = createNotificationPreferenceRuntime({ homePath, env, reviewStore: createReviewStore({ homePath }) });
      await expect(runtime.legacy.isAttentionPushEnabled({ ownerId: "default", kind: "completed" })).rejects.toThrow("runtime owner");
    } finally {
      await rm(homePath, { recursive: true, force: true });
    }
  });
});
