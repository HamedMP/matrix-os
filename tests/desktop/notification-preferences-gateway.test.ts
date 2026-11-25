// @vitest-environment jsdom
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { createCodingAgentNotificationPreferenceStore } from "../../packages/gateway/src/coding-agents/notification-preferences.js";
import { createNotificationPreferenceRoutes, createLegacyNotificationPreferenceRoutes } from "../../packages/gateway/src/notifications/routes.js";
import { INVOKE_CHANNELS } from "../../desktop/src/shared/ipc-contract";
import { fetchCodingAgentNotificationPreferences, updateCodingAgentNotificationPreferences } from "../../desktop/src/main/coding-agents/runtime-summary-client";
import type { AuthService } from "../../desktop/src/main/auth/auth-service";
import { clearCodingAgentRuntimeSelection, useCodingAgentWorkspace } from "../../desktop/src/renderer/src/stores/coding-agent-workspace";

const owner = "owner_desktop";
const homes: string[] = [];
afterEach(async () => {
  clearCodingAgentRuntimeSelection(); vi.unstubAllEnvs();
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })));
});

describe("desktop notification preference producer through the gateway", () => {
  it("commits only the desktop edit when mobile changes another switch after the desktop read", async () => {
    vi.stubEnv("MATRIX_USER_ID", owner);
    const homePath = await mkdtemp(join(tmpdir(), "matrix-desktop-notification-race-")); homes.push(homePath);
    const legacy = createCodingAgentNotificationPreferenceStore({ homePath, ownerIds: [owner] });
    const app = new Hono(); app.use("*", authMiddleware("desktop-token"));
    app.route("/api/notifications", createNotificationPreferenceRoutes({ store: legacy.preferences }));
    app.route("/api/coding-agents", createLegacyNotificationPreferenceRoutes({ store: legacy }));
    const auth = { getToken: () => "desktop-token", getGatewayOrigin: () => "https://runtime.test",
      getStatus: () => ({ signedIn: true, handle: "operator", runtimeSlot: "primary", platformHost: "https://runtime.test" }) } as unknown as AuthService;
    const ownerHeaders = { authorization: "Bearer desktop-token", "content-type": "application/json" };
    let mobileSaved = false;
    const writes: Array<{ method: string; body: unknown }> = [];
    // Only the network/IPC transport is local. Renderer, IPC schemas, main HTTP client,
    // gateway auth/routes, shared lock and persisted owner document all execute unchanged.
    const fetchFn: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("notification-preferences") && ["PUT", "PATCH"].includes(init?.method ?? "GET")) {
        if (!mobileSaved) {
          const document = (await (await app.request("/api/notifications/preferences", { headers: ownerHeaders })).json()).preferences;
          document.events.approval = false;
          const mobile = await app.request("/api/notifications/preferences", { method: "PUT", headers: ownerHeaders, body: JSON.stringify(document) });
          expect(mobile.status).toBe(200); mobileSaved = true;
        }
        writes.push({ method: init!.method!, body: JSON.parse(String(init!.body)) });
      }
      return app.request(url.pathname + url.search, init);
    };
    window.operator = { on: () => () => {}, invoke: async (channel, payload) => {
      if (channel === "runtime:get-notification-preferences") {
        INVOKE_CHANNELS[channel].request.parse(payload);
        return INVOKE_CHANNELS[channel].response.parse(await fetchCodingAgentNotificationPreferences(auth, fetchFn));
      }
      if (channel === "runtime:update-notification-preferences") {
        const request = INVOKE_CHANNELS[channel].request.parse(payload);
        return INVOKE_CHANNELS[channel].response.parse(await updateCodingAgentNotificationPreferences(auth, request, fetchFn));
      }
      throw new Error("unexpected IPC channel");
    } };
    clearCodingAgentRuntimeSelection();
    await useCodingAgentWorkspace.getState().loadNotificationPreferences();
    expect(useCodingAgentWorkspace.getState().notificationPreferencesStatus).toBe("ready");
    await useCodingAgentWorkspace.getState().updateNotificationPreferences({ attentionPush: { completed: false } });
    const persisted = (await (await app.request("/api/notifications/preferences", { headers: ownerHeaders })).json()).preferences;
    expect(persisted.events).toMatchObject({ approval: false, replyFinished: false });
    expect(persisted.revision).toBe(2);
    expect(useCodingAgentWorkspace.getState()).toMatchObject({ notificationPreferencesStatus: "ready",
      notificationPreferences: { attentionPush: { approval: false, completed: false } } });
    expect(writes).toEqual([{ method: "PATCH", body: { attentionPush: { completed: false } } }]);
    await Promise.all([
      useCodingAgentWorkspace.getState().updateNotificationPreferences({ attentionPush: { failed: false } }),
      useCodingAgentWorkspace.getState().updateNotificationPreferences({ attentionPush: { input: false } }),
    ]);
    const batched = (await (await app.request("/api/notifications/preferences", { headers: ownerHeaders })).json()).preferences;
    expect(batched.events).toMatchObject({ approval: false, question: false, runFailed: false, replyFinished: false });
    expect(writes[1]).toEqual({ method: "PATCH", body: { attentionPush: { failed: false, input: false } } });
  });
});
