import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createCodingAgentNotificationPreferenceStore } from "../../packages/gateway/src/coding-agents/notification-preferences.js";
import { createCodingAgentRoutes } from "../../packages/gateway/src/coding-agents/routes.js";
import type { RequestPrincipal } from "../../packages/gateway/src/request-principal.js";

const principal: RequestPrincipal = { userId: "owner_user", source: "jwt" };

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function appWithStore(homePath: string) {
  const app = new Hono();
  const notificationPreferences = createCodingAgentNotificationPreferenceStore({ homePath });
  let activePrincipal = principal;
  app.route("/api/coding-agents", createCodingAgentRoutes({
    service: { getSummary: async () => {
      throw new Error("not used");
    } },
    getPrincipal: () => activePrincipal,
    notificationPreferences,
  }));
  return {
    app,
    notificationPreferences,
    setPrincipal(nextPrincipal: RequestPrincipal) {
      activePrincipal = nextPrincipal;
    },
  };
}

describe("coding agent notification preferences", () => {
  it("serves default owner-scoped notification preferences", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-coding-agent-notification-prefs-"));
    const { app } = appWithStore(homePath);

    const res = await app.request("/api/coding-agents/notification-preferences");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      preferences: {
        attentionPush: {
          approval: true,
          input: true,
          failed: true,
          completed: true,
        },
      },
    });
  });

  it("upgrades legacy owner-scoped notification preferences with completion alerts enabled", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-coding-agent-notification-prefs-"));
    const { app } = appWithStore(homePath);
    await mkdir(join(homePath, "system", "coding-agents", "notification-preferences"), { recursive: true });
    await writeFile(
      join(homePath, "system", "coding-agents", "notification-preferences", "owner_user.json"),
      JSON.stringify({
        attentionPush: {
          approval: false,
          input: true,
          failed: false,
        },
      }),
      "utf-8",
    );

    const res = await app.request("/api/coding-agents/notification-preferences");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      preferences: {
        attentionPush: {
          approval: false,
          input: true,
          failed: false,
          completed: true,
        },
      },
    });
  });

  it("persists validated owner-scoped notification preferences atomically", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-coding-agent-notification-prefs-"));
    const { app } = appWithStore(homePath);

    const res = await app.request(jsonRequest("/api/coding-agents/notification-preferences", {
      attentionPush: {
        approval: false,
        input: true,
        failed: false,
        completed: true,
      },
    }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      preferences: {
        attentionPush: {
          approval: false,
          input: true,
          failed: false,
          completed: true,
        },
      },
    });

    const stored = await readFile(
      join(homePath, "system", "coding-agents", "notification-preferences", "owner_user.json"),
      "utf-8",
    );
    expect(JSON.parse(stored)).toEqual({
      attentionPush: {
        approval: false,
        input: true,
        failed: false,
        completed: true,
      },
    });
  });

  it("keeps notification preferences isolated by authenticated owner principal", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-coding-agent-notification-prefs-"));
    const { app, setPrincipal } = appWithStore(homePath);

    const ownerUpdate = await app.request(jsonRequest("/api/coding-agents/notification-preferences", {
      attentionPush: {
        approval: false,
        input: false,
        failed: false,
        completed: false,
      },
    }));
    expect(ownerUpdate.status).toBe(200);

    setPrincipal({ userId: "other_user", source: "jwt" });
    const otherRead = await app.request("/api/coding-agents/notification-preferences");

    expect(otherRead.status).toBe(200);
    await expect(otherRead.json()).resolves.toEqual({
      preferences: {
        attentionPush: {
          approval: true,
          input: true,
          failed: true,
          completed: true,
        },
      },
    });
  });

  it("rejects malformed or oversized preference updates with safe errors", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-coding-agent-notification-prefs-"));
    const { app } = appWithStore(homePath);

    const malformed = await app.request(jsonRequest("/api/coding-agents/notification-preferences", {
      attentionPush: {
        approval: true,
        input: true,
        failed: true,
        completed: true,
        rawProviderSetting: "/home/matrix/provider.log",
      },
    }));
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({
      error: {
        code: "validation_failed",
        safeMessage: "Request could not be processed. Check the inputs and try again.",
      },
    });

    const oversized = await app.request(new Request("http://localhost/api/coding-agents/notification-preferences", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attentionPush: { approval: true, input: true, failed: true, completed: true }, padding: "x".repeat(10_000) }),
    }));
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({
      error: {
        code: "payload_too_large",
        safeMessage: "Request is too large. Reduce the content and try again.",
      },
    });
  });

  it("maps invalid persisted preferences to a generic unavailable error", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-coding-agent-notification-prefs-"));
    const { app } = appWithStore(homePath);
    await mkdir(join(homePath, "system", "coding-agents", "notification-preferences"), { recursive: true });
    await writeFile(
      join(homePath, "system", "coding-agents", "notification-preferences", "owner_user.json"),
      JSON.stringify({
        attentionPush: {
          approval: true,
          input: true,
          failed: true,
          rawProviderSetting: "/home/matrix/provider.log",
        },
      }),
      "utf-8",
    );

    const res = await app.request("/api/coding-agents/notification-preferences");

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      error: {
        code: "notification_preferences_unavailable",
        safeMessage: "Notification preferences are temporarily unavailable. Try again.",
      },
    });
  });
});
