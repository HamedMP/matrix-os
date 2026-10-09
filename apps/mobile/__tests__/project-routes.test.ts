// Resolves the Projects URLs against the real files under app/ with Expo
// Router's own resolver, as route-tree.test.ts does for the rest of the app.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { getStateFromPath } from "expo-router/build/fork/getStateFromPath";
import { getMockConfig } from "expo-router/build/testing-library/mock-config";

import { projectsScreenParams } from "../lib/shell-routes";
import { TAB_BAR_HIDDEN_ROUTES, isTabBarHidden } from "../lib/tab-bar-visibility";

jest.mock("expo-router", () => ({ Stack: () => null }));

const appDirectory = join(__dirname, "../app");

function routeFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? routeFiles(path) : path.endsWith(".tsx") ? [path] : [];
  });
}

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
  routes: { name: string; params?: Record<string, unknown>; state?: ResolvedState }[];
}

const config = getMockConfig(routeModules() as never);

/** The screen a URL opens, with the navigators it passes through, outermost first. */
function resolve(url: string): { path: string[]; params?: Record<string, unknown> } {
  const path: string[] = [];
  let state = getStateFromPath(url, config as never) as ResolvedState | undefined;
  let params: Record<string, unknown> | undefined;
  while (state) {
    const route = state.routes[state.index ?? state.routes.length - 1];
    path.push(route.name);
    params = route.params;
    state = route.state;
  }
  return { path, params };
}

const CHATS_STACK = ["__root", "(drawer)", "(tabs)", "(chats)"];

describe("project routes", () => {
  it("opens the projects list at /projects, inside the Chats stack", () => {
    expect(resolve("/projects").path).toEqual([...CHATS_STACK, "projects/index"]);
  });

  it("opens a project at /projects/<id>, inside the Chats stack, with its id", () => {
    const project = resolve("/projects/proj_0f8fad5b");

    expect(project.path).toEqual([...CHATS_STACK, "projects/[projectId]"]);
    expect(project.params).toMatchObject({ projectId: "proj_0f8fad5b" });
  });

  it("is where the side panel's Projects row goes", () => {
    const [, , tabs, chats, screen] = resolve("/projects").path;

    expect(tabs).toBe("(tabs)");
    expect(projectsScreenParams()).toEqual({ screen: chats, params: { screen } });
  });

  it("keeps the tab bar on both screens", () => {
    for (const url of ["/projects", "/projects/proj_0f8fad5b"]) {
      const [, , , tab, screen] = resolve(url).path;
      expect(isTabBarHidden(tab, screen, TAB_BAR_HIDDEN_ROUTES)).toBe(false);
    }
  });
});
