import { Hono } from "hono";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createShellRoutes } from "../../packages/gateway/src/shell/routes.js";
import {
  ShellPreferencesSchema,
  ShellPreferencesStore,
  type ShellPreferences,
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
      shellThemeId: "matrix",
      fontFamily: "MesloLGS NF",
      ligatures: true,
      cursorStyle: "bar",
      smoothScroll: true,
    })).toMatchObject({ shellThemeId: "matrix", fontFamily: "MesloLGS NF" });

    expect(ShellPreferencesSchema.parse({ themeId: "dracula" })).toMatchObject({
      shellThemeId: "dark",
    });
    expect(ShellPreferencesSchema.parse({ themeId: "one-light" })).toMatchObject({
      shellThemeId: "light",
    });
    expect(ShellPreferencesSchema.parse({ shellThemeId: "powerlevel10k-rainbow" })).toMatchObject({
      shellThemeId: "powerlevel10k-rainbow",
    });

    expect(() => ShellPreferencesSchema.parse({ fontFamily: "../bad" })).toThrow();
    expect(() => ShellPreferencesSchema.parse({ shellThemeId: "dracula" })).toThrow();
  });

  it("persists per-session preferences atomically", async () => {
    const root = await tempRoot();
    const store = new ShellPreferencesStore({ homePath: root });

    await store.save("main", { shellThemeId: "matrix", fontFamily: "MesloLGS NF" });

    await expect(store.load("main")).resolves.toMatchObject({
      shellThemeId: "matrix",
      fontFamily: "MesloLGS NF",
    });
  });

  it("serializes global preference patches so concurrent clients cannot lose fields", async () => {
    const root = await tempRoot();
    const store = new ShellPreferencesStore({ homePath: root });
    let releaseFirstSave: (() => void) | undefined;
    const originalSaveGlobal = store.saveGlobal.bind(store);
    const saveGlobal = vi.spyOn(store, "saveGlobal")
      .mockImplementationOnce(async (input) => {
        await new Promise<void>((resolve) => {
          releaseFirstSave = resolve;
        });
        return originalSaveGlobal(input);
      })
      .mockImplementation((input) => originalSaveGlobal(input));

    const first = store.updateGlobal({ shellThemeId: "matrix" });
    await vi.waitFor(() => expect(saveGlobal).toHaveBeenCalledTimes(1));
    const second = store.updateGlobal({ fontFamily: "Fira Code" });
    await Promise.resolve();
    expect(saveGlobal).toHaveBeenCalledTimes(1);

    releaseFirstSave?.();
    await Promise.all([first, second]);

    await expect(store.loadGlobal()).resolves.toMatchObject({
      shellThemeId: "matrix",
      fontFamily: "Fira Code",
    });
  });

  it("serializes global preference side effects with their persisted updates", async () => {
    const root = await tempRoot();
    const store = new ShellPreferencesStore({ homePath: root });
    const order: string[] = [];
    let appliedTheme = "dark";
    let releaseFirstApply: (() => void) | undefined;

    const first = store.updateGlobal(
      { shellThemeId: "matrix" },
      async (preferences: ShellPreferences) => {
        order.push(`${preferences.shellThemeId}:start`);
        await new Promise<void>((resolve) => {
          releaseFirstApply = resolve;
        });
        appliedTheme = preferences.shellThemeId;
        order.push(`${preferences.shellThemeId}:end`);
      },
    );
    await vi.waitFor(() => expect(order).toEqual(["matrix:start"]));

    const second = store.updateGlobal(
      { shellThemeId: "light" },
      async (preferences: ShellPreferences) => {
        order.push(`${preferences.shellThemeId}:start`);
        appliedTheme = preferences.shellThemeId;
        order.push(`${preferences.shellThemeId}:end`);
      },
    );
    await Promise.resolve();
    expect(order).toEqual(["matrix:start"]);

    releaseFirstApply?.();
    await Promise.all([first, second]);

    expect(order).toEqual(["matrix:start", "matrix:end", "light:start", "light:end"]);
    expect(appliedTheme).toBe("light");
    await expect(store.loadGlobal()).resolves.toMatchObject({ shellThemeId: "light" });
  });

  it("renames per-session preferences without overwriting another preference file", async () => {
    const root = await tempRoot();
    const store = new ShellPreferencesStore({ homePath: root });

    await store.save("main", { shellThemeId: "matrix", fontFamily: "MesloLGS NF" });
    await store.rename("main", "review-main");

    await expect(store.load("main")).resolves.toMatchObject({ shellThemeId: "dark" });
    await expect(store.load("review-main")).resolves.toMatchObject({
      shellThemeId: "matrix",
      fontFamily: "MesloLGS NF",
    });

    await store.rename("missing", "new-name");
    await store.save("occupied", { shellThemeId: "light" });
    await expect(store.rename("review-main", "occupied")).rejects.toMatchObject({
      code: "session_exists",
      status: 409,
    });
  });

  it("keeps the destination preferences when source cleanup already happened", async () => {
    const root = await tempRoot();
    const rmMock = vi.fn(async (path: string) => {
      if (path.endsWith("main.json")) {
        throw Object.assign(new Error("missing source"), { code: "ENOENT" });
      }
    });
    const store = new ShellPreferencesStore({
      homePath: root,
      renameFileOps: {
        mkdir: vi.fn(async () => undefined) as never,
        link: vi.fn(async () => undefined),
        rm: rmMock as never,
      },
    });

    await expect(store.rename("main", "review-main")).resolves.toBeUndefined();

    expect(rmMock).toHaveBeenCalledTimes(1);
    expect(rmMock.mock.calls[0]?.[0]).toContain("main.json");
    expect(rmMock.mock.calls.some(([path]) => String(path).endsWith("review-main.json"))).toBe(false);
  });

  it("serves GET and PUT preferences routes with validation", async () => {
    const root = await tempRoot();
    const preferences = new ShellPreferencesStore({ homePath: root });
    const setShellTheme = vi.fn(async () => {});
    const app = new Hono();
    app.route("/api", createShellRoutes({
      registry: {
        list: vi.fn(async () => []),
        create: vi.fn(),
        delete: vi.fn(),
      },
      preferences,
      shellThemeConfig: { setShellTheme },
    }));

    const put = await app.request("/api/sessions/main/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shellThemeId: "light", fontFamily: "MesloLGS NF", cursorStyle: "underline" }),
    });
    expect(put.status).toBe(200);
    expect(setShellTheme).toHaveBeenCalledWith("light");

    const get = await app.request("/api/sessions/main/preferences");
    expect(get.status).toBe(200);
    await expect(get.json()).resolves.toMatchObject({
      preferences: {
        shellThemeId: "light",
        fontFamily: "MesloLGS NF",
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

  it("serves global terminal preferences separately from session preferences", async () => {
    const root = await tempRoot();
    const preferences = new ShellPreferencesStore({ homePath: root });
    const setShellTheme = vi.fn(async () => {});
    const app = new Hono();
    app.route("/api", createShellRoutes({
      registry: {
        list: vi.fn(async () => []),
        create: vi.fn(),
        delete: vi.fn(),
      },
      preferences,
      shellThemeConfig: { setShellTheme },
    }));

    const put = await app.request("/api/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shellThemeId: "powerlevel10k-classic" }),
    });
    expect(put.status).toBe(200);
    expect(setShellTheme).toHaveBeenCalledWith("powerlevel10k-classic");

    const globalGet = await app.request("/api/preferences");
    expect(globalGet.status).toBe(200);
    await expect(globalGet.json()).resolves.toMatchObject({
      preferences: { shellThemeId: "powerlevel10k-classic" },
    });

    const sessionGet = await app.request("/api/sessions/main/preferences");
    expect(sessionGet.status).toBe(200);
    await expect(sessionGet.json()).resolves.toMatchObject({
      preferences: { shellThemeId: "dark" },
    });

    const terminalSessionPut = await app.request("/api/sessions/terminal/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shellThemeId: "light" }),
    });
    expect(terminalSessionPut.status).toBe(200);

    const globalAfterTerminalSession = await app.request("/api/preferences");
    expect(globalAfterTerminalSession.status).toBe(200);
    await expect(globalAfterTerminalSession.json()).resolves.toMatchObject({
      preferences: { shellThemeId: "powerlevel10k-classic" },
    });
  });

  it("routes global shell theme application through the serialized preference update", async () => {
    const root = await tempRoot();
    const preferences = new ShellPreferencesStore({ homePath: root });
    const updateGlobal = vi.spyOn(preferences, "updateGlobal");
    const setShellTheme = vi.fn(async () => {});
    const app = new Hono();
    app.route("/api", createShellRoutes({
      registry: {
        list: vi.fn(async () => []),
        create: vi.fn(),
        delete: vi.fn(),
      },
      preferences,
      shellThemeConfig: { setShellTheme },
    }));

    const response = await app.request("/api/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shellThemeId: "matrix" }),
    });

    expect(response.status).toBe(200);
    expect(updateGlobal.mock.calls[0]?.[1]).toEqual(expect.any(Function));
    expect(setShellTheme).toHaveBeenCalledWith("matrix");
  });

  it("serves PATCH session UI state with validation and body limits", async () => {
    const updateUiState = vi.fn(async () => ({
      name: "main",
      placement: "background",
      visualStatus: "waiting",
      lastSeenSeq: 12,
      latestSeq: 15,
      unread: true,
    }));
    const app = new Hono();
    app.route("/api", createShellRoutes({
      registry: {
        list: vi.fn(async () => []),
        create: vi.fn(),
        delete: vi.fn(),
        updateUiState,
      },
    }));

    const patch = await app.request("/api/sessions/main/ui-state", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        placement: "background",
        visualStatus: "waiting",
        lastSeenSeq: 12,
      }),
    });
    expect(patch.status).toBe(200);
    await expect(patch.json()).resolves.toMatchObject({
      session: {
        name: "main",
        placement: "background",
        visualStatus: "waiting",
      },
    });
    expect(updateUiState).toHaveBeenCalledWith("main", {
      placement: "background",
      lastSeenSeq: 12,
    });

    const invalid = await app.request("/api/sessions/main/ui-state", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ placement: "foreground" }),
    });
    expect(invalid.status).toBe(400);

    const tooLarge = await app.request("/api/sessions/main/ui-state", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: "x".repeat(4096) }),
    });
    expect(tooLarge.status).toBe(413);
  });
});
