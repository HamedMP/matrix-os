import { OS_VIEW_PLACEABLE_BUILTIN_APPS } from "@matrix-os/contracts";

import {
  buildLauncherEntries,
  defaultAppColors,
  filterLauncherEntries,
  hasInstalledApps,
  launcherStatus,
  type LauncherEntry,
} from "../lib/apps-launcher";
import type { MatrixAppEntry } from "../lib/apps";

const app = (name: string, folder: string, overrides: Partial<MatrixAppEntry> = {}): MatrixAppEntry => ({
  name,
  slug: folder.split("/").pop(),
  file: `${folder}/index.html`,
  path: `/files/apps/${folder}/index.html`,
  ...overrides,
});

const names = (entries: readonly LauncherEntry<MatrixAppEntry>[]) => entries.map((entry) => entry.name);

const catalog = [
  app("2048", "games/2048"),
  app("Calculator", "calculator"),
  app("Notes", "notes"),
  app("Weather", "weather"),
  app("Whiteboard", "whiteboard"),
];

describe("buildLauncherEntries", () => {
  it("puts the default apps first, in the desktop launcher's order, then the installed apps", () => {
    expect(names(buildLauncherEntries(catalog))).toEqual([
      "Chat",
      "Terminal",
      "Files",
      "Settings",
      "Connect Apps",
      "Notes",
      "Whiteboard",
      "2048",
      "Calculator",
      "Weather",
    ]);
  });

  it("follows the order the desktop launcher declares, skipping defaults with no screen here", () => {
    const defaults = buildLauncherEntries(catalog).slice(0, 7);
    const desktopOrder = OS_VIEW_PLACEABLE_BUILTIN_APPS
      .map((builtIn) => builtIn.name)
      .filter((name) => !["Editor", "VS Code", "Browser", "Cloud desktop"].includes(name));

    expect(names(defaults)).toEqual(desktopOrder);
  });

  it("sends each default app without a web app of its own to a screen of this app", () => {
    const destinations = buildLauncherEntries([]).map((entry) => (
      entry.kind === "default" ? [entry.id, entry.destination] : null
    ));

    expect(destinations).toEqual([
      ["chat", { kind: "tab", tab: "chats" }],
      ["terminal", { kind: "tab", tab: "terminal" }],
      ["files", { kind: "screen", href: "/files" }],
      ["settings", { kind: "tab", tab: "settings" }],
      ["plugins", { kind: "screen", href: "/integrations" }],
    ]);
  });

  it("lists Notes and Whiteboard among the defaults only when they are installed", () => {
    const entries = buildLauncherEntries([app("Weather", "weather"), app("Whiteboard", "whiteboard")]);

    expect(names(entries)).toEqual([
      "Chat", "Terminal", "Files", "Settings", "Connect Apps", "Whiteboard", "Weather",
    ]);
    expect(entries[5]).toEqual({
      kind: "installed",
      name: "Whiteboard",
      app: app("Whiteboard", "whiteboard"),
    });
  });

  it("finds a promoted app by where it is installed, whatever its build output or name", () => {
    const renamed = app("My notes", "notes", {
      file: "notes/dist/index.html",
      path: "/files/apps/notes/dist/index.html",
    });

    expect(names(buildLauncherEntries([app("Abacus", "abacus"), renamed]))).toEqual([
      "Chat", "Terminal", "Files", "Settings", "Connect Apps", "My notes", "Abacus",
    ]);
  });

  it.each([
    ["Chat", "chat"],
    ["Terminal", "terminal"],
    ["Workspace", "workspace"],
    ["Browser", "browser"],
  ])("leaves out the installed %s web app, which a default app replaces", (name, folder) => {
    const entries = buildLauncherEntries([app(name, folder), app("Weather", "weather")]);

    expect(entries.filter((entry) => entry.kind === "installed").map((entry) => entry.name)).toEqual(["Weather"]);
  });

  it("leaves out the single-file Browser app older computers still carry", () => {
    const legacy: MatrixAppEntry = { name: "Browser", file: "browser.html", path: "/files/apps/browser.html" };

    expect(names(buildLauncherEntries([legacy])).includes("Browser")).toBe(false);
  });

  it("keeps an app that only shares a name with a default app", () => {
    const entries = buildLauncherEntries([app("Chat", "team-chat"), app("Terminal", "games/terminal")]);

    expect(names(entries)).toEqual([
      "Chat", "Terminal", "Files", "Settings", "Connect Apps", "Chat", "Terminal",
    ]);
  });

  it("goes by where an app is installed, never by a name standing in for an unreadable location", () => {
    const unreadable: MatrixAppEntry = { name: "Chat", file: "Chat App/index.html", path: "/files/apps/Chat App/index.html" };
    const unreadableNotes: MatrixAppEntry = { name: "Notes", file: "My Notes!/index.html", path: "/files/apps/My Notes!/index.html" };

    expect(buildLauncherEntries([unreadable, unreadableNotes]).slice(5)).toEqual([
      { kind: "installed", name: "Chat", app: unreadable },
      { kind: "installed", name: "Notes", app: unreadableNotes },
    ]);
  });

  it("keeps the installed apps in the order they arrive", () => {
    const entries = buildLauncherEntries([app("Zebra", "zebra"), app("Abacus", "abacus")]);

    expect(names(entries).slice(5)).toEqual(["Zebra", "Abacus"]);
  });
});

describe("filterLauncherEntries", () => {
  const entries = buildLauncherEntries(catalog);

  it("returns every entry for an empty or blank search", () => {
    expect(filterLauncherEntries(entries, "")).toEqual(entries);
    expect(filterLauncherEntries(entries, "   ")).toEqual(entries);
  });

  it("matches default and installed apps by name, ignoring case", () => {
    expect(names(filterLauncherEntries(entries, "TE"))).toEqual(["Terminal", "Notes", "Whiteboard"]);
    expect(names(filterLauncherEntries(entries, " connect "))).toEqual(["Connect Apps"]);
    expect(filterLauncherEntries(entries, "nothing like this")).toEqual([]);
  });
});

describe("hasInstalledApps", () => {
  it("is false while only the built-in defaults are listed", () => {
    expect(hasInstalledApps(buildLauncherEntries([]))).toBe(false);
  });

  it("is true once the computer lists a web app, promoted or not", () => {
    expect(hasInstalledApps(buildLauncherEntries([app("Notes", "notes")]))).toBe(true);
    expect(hasInstalledApps(buildLauncherEntries([app("Weather", "weather")]))).toBe(true);
  });
});

describe("launcherStatus", () => {
  const loaded = { isPending: false, isError: false, searching: false };
  const defaultsOnly = buildLauncherEntries([]);
  const withApps = buildLauncherEntries(catalog);

  it("says nothing once the computer's apps are listed", () => {
    expect(launcherStatus({ ...loaded, entries: withApps, visibleCount: withApps.length })).toBeNull();
  });

  it("is loading until the computer's apps arrive, whatever else is true", () => {
    expect(launcherStatus({ ...loaded, isPending: true, isError: true, entries: defaultsOnly, visibleCount: 0 }))
      .toBe("loading");
  });

  it("is unavailable when the computer's apps cannot be read", () => {
    expect(launcherStatus({ ...loaded, isError: true, entries: defaultsOnly, visibleCount: defaultsOnly.length }))
      .toBe("unavailable");
  });

  it("reports a search that matches nothing", () => {
    expect(launcherStatus({ ...loaded, searching: true, entries: withApps, visibleCount: 0 })).toBe("no-match");
    expect(launcherStatus({ ...loaded, searching: true, entries: defaultsOnly, visibleCount: 0 })).toBe("no-match");
  });

  it("reports a computer with no web apps, but not in the middle of a search", () => {
    expect(launcherStatus({ ...loaded, entries: defaultsOnly, visibleCount: defaultsOnly.length }))
      .toBe("none-installed");
    expect(launcherStatus({ ...loaded, searching: true, entries: defaultsOnly, visibleCount: 1 })).toBeNull();
  });
});

describe("defaultAppColors", () => {
  it("uses the desktop launcher's colours for each default app", () => {
    expect(defaultAppColors("chat")).toEqual({ background: "#BA5236", foreground: "white" });
    expect(defaultAppColors("terminal")).toEqual({ background: "#E0AA52", foreground: "white" });
    expect(defaultAppColors("files")).toEqual({ background: "#748E59", foreground: "white" });
    expect(defaultAppColors("settings")).toEqual({ background: "#6B7280", foreground: "white" });
    expect(defaultAppColors("plugins")).toEqual({ background: "#7C6DB4", foreground: "white" });
  });

  it("gives every default app a colour this app can draw, with no CSS left in it", () => {
    const defaults = buildLauncherEntries([]).flatMap((entry) => (entry.kind === "default" ? [entry.id] : []));

    expect(defaults).toHaveLength(5);
    for (const id of defaults) {
      expect(defaultAppColors(id).background).toMatch(/^#[0-9A-F]{6}$/i);
    }
  });
});
