// Resolves URLs against the real files under app/ with Expo Router's own
// resolver, so a moved or added route cannot quietly change where a URL lands.
jest.mock("expo-router", () => ({ Stack: () => null }));

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { getStateFromPath } from "expo-router/build/fork/getStateFromPath";
import { getMockConfig } from "expo-router/build/testing-library/mock-config";

const appDirectory = join(__dirname, "../app");

function routeFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? routeFiles(path) : path.endsWith(".tsx") ? [path] : [];
  });
}

/**
 * Every route as an empty screen. A layout's `unstable_settings` decides which
 * of its screens a link puts beneath the one it opens, so those are the real
 * exports.
 */
function routeModules(): Record<string, unknown> {
  return Object.fromEntries(routeFiles(appDirectory).map((file) => {
    const route = relative(appDirectory, file).replace(/\.tsx$/, "");
    const screen = { default: () => null };
    if (!/export const unstable_settings\b/.test(readFileSync(file, "utf8"))) return [route, screen];
    const { unstable_settings } = jest.requireActual(file) as { unstable_settings: unknown };
    return [route, { ...screen, unstable_settings }];
  }));
}

interface ResolvedState {
  index?: number;
  routes: { name: string; state?: ResolvedState }[];
}

const config = getMockConfig(routeModules() as never);

/** The routes of each navigator a URL passes through, outermost first, below the root. */
function resolve(url: string): string[][] {
  const levels: string[][] = [];
  let state = getStateFromPath(url, config as never) as ResolvedState | undefined;
  while (state) {
    levels.push(state.routes.map((route) => route.name));
    state = state.routes[state.index ?? state.routes.length - 1].state;
  }
  expect(levels[0]).toEqual(["__root"]);
  return levels.slice(1);
}

const TABS = ["(drawer)", "(tabs)"].map((name) => [name]);

describe("route tree", () => {
  it("opens the sign-in and journey gate at the root URL, not the chat screen that shares it", () => {
    // app/index.tsx and the chat screen are both `/`. A launch has to reach
    // the gate, which decides whether the person may enter the shell.
    expect(resolve("/")).toEqual([["index"]]);
  });

  it("opens the chat screen for the href the gate, sign-in and notifications use", () => {
    expect(resolve("/(drawer)")).toEqual([...TABS, ["(chats)"], ["index"]]);
  });

  it("keeps every shell screen at the URL it had as a drawer destination", () => {
    expect(resolve("/shared")).toEqual([...TABS, ["(chats)"], ["shared"]]);
    expect(resolve("/apps")).toEqual([...TABS, ["(apps)"], ["apps"]]);
    expect(resolve("/terminal")).toEqual([...TABS, ["terminal"]]);
    expect(resolve("/settings")).toEqual([...TABS, ["settings"]]);
  });

  it("puts the Agents tab at /agents", () => {
    expect(resolve("/agents")).toEqual([...TABS, ["agents"], ["index"]]);
  });

  it("leaves Apps beneath Files and Connect Apps when a link opens them directly", () => {
    expect(resolve("/files")).toEqual([...TABS, ["(apps)"], ["apps", "files"]]);
    // The Connect Apps sign-in returns to the app through matrixos://integrations.
    expect(resolve("/integrations")).toEqual([...TABS, ["(apps)"], ["apps", "integrations"]]);
  });

  it("keeps the screens outside the tabs where they were", () => {
    expect(resolve("/sign-in")).toEqual([["sign-in"]]);
    expect(resolve("/sign-in-computer")).toEqual([["sign-in-computer"]]);
    expect(resolve("/file-browser")).toEqual([["file-browser"], ["index"]]);
    expect(resolve("/file-browser/file")).toEqual([["file-browser"], ["file"]]);
    expect(resolve("/terminal-session/main")).toEqual([["terminal-session"], ["[session]"]]);
    expect(resolve("/app-preview/chess")).toEqual([["app-preview"], ["[app]"]]);
    expect(resolve("/integration-detail/github")).toEqual([["integration-detail"], ["[integration]"]]);
    expect(resolve("/integrations-installed")).toEqual([["integrations-installed"], ["index"]]);
    expect(resolve("/settings-detail/system")).toEqual([["settings-detail"], ["system"]]);
  });
});
