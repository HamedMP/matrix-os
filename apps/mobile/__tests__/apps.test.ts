import {
  buildGatewayAppUrl,
  appRuntimeHref,
  encodeAppSlugPath,
  getAppIconName,
  getGatewayAppUrlLabel,
  getAppSlug,
  getNativeAppRoute,
  getRuntimeSlug,
  slugFromParam,
  mergeNativeAndRemoteApps,
  type MatrixAppEntry,
} from "../lib/apps";

const app = (overrides: Partial<MatrixAppEntry>): MatrixAppEntry => ({
  name: "Notes",
  file: "notes/index.html",
  path: "/files/apps/notes/index.html",
  ...overrides,
});

describe("mobile app helpers", () => {
  it("derives slugs from nested directory apps", () => {
    expect(getAppSlug(app({ file: "games/snake/index.html" }))).toBe("games/snake");
  });

  it("derives slugs from legacy html apps", () => {
    expect(getAppSlug(app({ file: "calculator.html" }))).toBe("calculator");
  });

  it("normalizes slugs from gateway paths with casing, duplicate slashes, and cache params", () => {
    expect(getAppSlug(app({
      name: "Notes",
      file: "/files/apps//Notes/index.html?v=abc#top",
      path: "/files/apps//Notes/index.html?v=abc#top",
    }))).toBe("notes");
  });

  it("falls back to a safe name slug for unsafe app paths", () => {
    expect(getAppSlug(app({
      name: "Internal Secrets",
      file: "../system/secrets/index.html",
      path: "/files/apps/../system/secrets/index.html",
    }))).toBe("internal-secrets");
  });

  it("routes known Matrix apps to native screens", () => {
    expect(getNativeAppRoute(app({ name: "Task Manager", file: "task-manager/index.html" }))).toBe(
      "/(tabs)/mission-control",
    );
    expect(getNativeAppRoute(app({ name: "Chat", file: "chat/index.html" }))).toBe("/(tabs)/chat");
    expect(getNativeAppRoute(app({ name: "Terminal", file: "terminal/index.html" }))).toBe("/terminal");
  });

  it("leaves generated apps on native detail screens before browser fallback", () => {
    expect(getNativeAppRoute(app({ name: "Workout Tracker", file: "workout/index.html" }))).toBeNull();
  });

  it("builds absolute gateway app URLs", () => {
    expect(buildGatewayAppUrl("http://localhost:4000/", app({}))).toBe(
      "http://localhost:4000/apps/notes/",
    );
  });

  it("builds app runtime URLs from nested app manifest slugs", () => {
    const chess = app({
      name: "Chess",
      slug: "chess",
      file: "games/chess/index.html",
      path: "/files/apps/games/chess/index.html",
    });

    expect(getRuntimeSlug(chess)).toBe("chess");
    expect(buildGatewayAppUrl("https://app.matrix-os.com", chess)).toBe(
      "https://app.matrix-os.com/apps/chess/",
    );
  });

  it("preserves nested runtime slugs when the gateway omits explicit slugs", () => {
    const snake = app({
      name: "Snake",
      file: "games/snake/index.html",
      path: "/files/apps/games/snake/index.html",
    });

    expect(getRuntimeSlug(snake)).toBe("games/snake");
    expect(buildGatewayAppUrl("https://app.matrix-os.com", snake)).toBe(
      "https://app.matrix-os.com/apps/games/snake/",
    );
  });

  it("encodes nested runtime slug path segments without escaping separators", () => {
    expect(encodeAppSlugPath("games/snake board")).toBe("games/snake%20board");
  });

  it("normalizes route slug params from Expo Router catch-all params", () => {
    expect(slugFromParam(["games", "snake"])).toBe("games/snake");
    expect(slugFromParam("notes")).toBe("notes");
    expect(slugFromParam(undefined)).toBe("");
  });

  it("uses backend launch URLs when provided", () => {
    expect(
      buildGatewayAppUrl("https://app.matrix-os.com", app({ slug: "notes", launchUrl: "/apps/notes/" })),
    ).toBe("https://app.matrix-os.com/apps/notes/");
  });

  it("falls back to the app slug when a backend launch URL is malformed", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

    expect(
      getGatewayAppUrlLabel("https://app.matrix-os.com", app({ slug: "notes", launchUrl: "https://" })),
    ).toBe("notes");

    warn.mockRestore();
  });

  it("builds runtime hrefs for generated apps", () => {
    expect(appRuntimeHref("games/snake")).toEqual({
      pathname: "/runtime/[...slug]",
      params: { slug: ["games", "snake"] },
    });
  });

  it("routes non-native launcher apps to the full-screen runtime surface", () => {
    const workout = app({ name: "Workout Tracker", file: "workout/index.html" });

    expect(getNativeAppRoute(workout)).toBeNull();
    expect(appRuntimeHref(getAppSlug(workout))).toEqual({
      pathname: "/runtime/[...slug]",
      params: { slug: ["workout"] },
    });
  });

  it("does not claim the agents slug when the workspace flag is disabled", () => {
    const remoteAgents = app({ name: "Agents", slug: "agents", file: "agents/index.html" });

    expect(getNativeAppRoute(remoteAgents)).toBeNull();
    expect(appRuntimeHref(getRuntimeSlug(remoteAgents))).toEqual({
      pathname: "/runtime/[...slug]",
      params: { slug: ["agents"] },
    });
  });

  it("keeps missing generated apps on runtime routes so the screen can show a safe fallback", () => {
    const missing = app({ name: "Missing App", file: "missing/index.html" });

    expect(getNativeAppRoute(missing)).toBeNull();
    expect(getRuntimeSlug(missing)).toBe("missing");
  });

  it("encodes normalized app runtime URLs without leaking unsafe paths", () => {
    expect(buildGatewayAppUrl(
      "https://app.matrix-os.com/",
      app({ name: "Internal Secrets", file: "../system/secrets/index.html" }),
    )).toBe("https://app.matrix-os.com/apps/internal-secrets/");
  });

  it("selects useful native symbols for app cards", () => {
    expect(getAppIconName(app({ name: "Pomodoro", category: "productivity" }))).toBe("timer");
    expect(getAppIconName(app({ name: "Snake", category: "game" }))).toBe("game-controller");
    expect(getAppIconName(app({ name: "Terminal", category: "system" }))).toBe("terminal");
  });

  it("keeps native Matrix apps visible when the VPS app list is empty", () => {
    const apps = mergeNativeAndRemoteApps([]);
    expect(apps.map((entry) => entry.name)).toEqual(["Chat", "Apps", "Terminal", "Canvas", "Tasks", "Settings"]);
  });

  it("appends remote apps after native Matrix apps", () => {
    const apps = mergeNativeAndRemoteApps([app({ name: "Workout Tracker", file: "workout/index.html" })]);
    expect(apps.map((entry) => entry.name)).toEqual(["Chat", "Apps", "Terminal", "Canvas", "Tasks", "Settings", "Workout Tracker"]);
  });

  it("includes the native Agents app only when explicitly opted in", () => {
    const originalValue = process.env.EXPO_PUBLIC_CODING_AGENTS_MOBILE_WORKSPACE;
    process.env.EXPO_PUBLIC_CODING_AGENTS_MOBILE_WORKSPACE = "1";

    jest.isolateModules(() => {
      const appsModule = require("../lib/apps") as typeof import("../lib/apps");
      const apps = appsModule.mergeNativeAndRemoteApps([]);

      expect(apps.map((entry) => entry.name)).toContain("Agents");
      expect(appsModule.getNativeAppRoute(app({ name: "Agents", slug: "agents", file: "agents/index.html" }))).toBe("/agents");
    });

    if (originalValue === undefined) {
      delete process.env.EXPO_PUBLIC_CODING_AGENTS_MOBILE_WORKSPACE;
    } else {
      process.env.EXPO_PUBLIC_CODING_AGENTS_MOBILE_WORKSPACE = originalValue;
    }
  });

  it("routes Canvas to the native explicit Canvas entry screen", () => {
    expect(getNativeAppRoute(app({ name: "Canvas", slug: "canvas", file: "canvas/index.html" }))).toBe("/canvas");
  });
});
