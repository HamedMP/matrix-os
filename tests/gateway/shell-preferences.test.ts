import { Hono } from "hono";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createShellRoutes } from "../../packages/gateway/src/shell/routes.js";
import {
  ShellPreferencesSchema,
  ShellPreferencesStore,
} from "../../packages/gateway/src/shell/preferences.js";

const roots: string[] = [];

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "matrix-shell-prefs-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("shell preferences", () => {
  it("validates the preferences schema", () => {
    expect(ShellPreferencesSchema.parse({
      themeId: "dracula",
      fontFamily: "Fira Code",
      ligatures: true,
      cursorStyle: "bar",
      smoothScroll: true,
    })).toMatchObject({ themeId: "dracula" });

    expect(() => ShellPreferencesSchema.parse({ fontFamily: "../bad" })).toThrow();
  });

  it("persists per-session preferences atomically", async () => {
    const root = await tempRoot();
    const store = new ShellPreferencesStore({ homePath: root });

    await store.save("main", { themeId: "nord", fontFamily: "JetBrains Mono" });

    await expect(store.load("main")).resolves.toMatchObject({
      themeId: "nord",
      fontFamily: "JetBrains Mono",
    });
  });

  it("serves GET and PUT preferences routes with validation", async () => {
    const root = await tempRoot();
    const preferences = new ShellPreferencesStore({ homePath: root });
    const app = new Hono();
    app.route("/api", createShellRoutes({
      registry: {
        list: vi.fn(async () => []),
        create: vi.fn(),
        delete: vi.fn(),
      },
      preferences,
    }));

    const put = await app.request("/api/sessions/main/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fontFamily: "Berkeley Mono", cursorStyle: "underline" }),
    });
    expect(put.status).toBe(200);

    const get = await app.request("/api/sessions/main/preferences");
    expect(get.status).toBe(200);
    await expect(get.json()).resolves.toMatchObject({
      preferences: {
        fontFamily: "Berkeley Mono",
        cursorStyle: "underline",
      },
    });

    const invalid = await app.request("/api/sessions/main/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fontFamily: "../bad" }),
    });
    expect(invalid.status).toBe(400);
  });
});
