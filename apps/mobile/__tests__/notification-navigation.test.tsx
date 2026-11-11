// Drives Expo Router's own navigators over a stand-in of the app's route tree
// to check where a notification tap lands, whatever was open when it came.
// The navigation calls are made from the root layout, as the app's are.
import { act } from "@testing-library/react-native";
import { useEffect } from "react";
import { router, Slot, Stack, useNavigationContainerRef } from "expo-router";
import { Tabs } from "expo-router/tabs";
import { renderRouter, type RenderRouterResult } from "expo-router/testing-library";

import { unstable_settings as appsSettings } from "../app/(drawer)/(tabs)/(apps)/_layout";
import { unstable_settings as chatsSettings } from "../app/(drawer)/(tabs)/(chats)/_layout";
import {
  openTerminalFromRoot,
  showChatListFromRoot,
  showChatScreenFromRoot,
  type RootNavigation,
} from "../lib/notification-navigation";

// The Chats layout's provider loads Clerk, whose import opens a MessagePort
// that keeps Jest from exiting. Only the layouts' settings are read here.
jest.mock("@/components/chat/active-chat", () => ({
  ActiveChatProvider: ({ children }: { children: unknown }) => children,
}));

const Empty = () => null;
const TAB_ROUTES = ["(chats)", "agents", "(apps)", "terminal", "settings"];
const TERMINAL = "tws_00000000000000000000000000000001:tt_00000000000000000000000000000001";
const OTHER_TERMINAL = "tws_00000000000000000000000000000002:tt_00000000000000000000000000000002";

const root: { navigation?: RootNavigation } = {};

/** Sits beside the root stack, where the app's notification router is. */
function RootProbe() {
  const navigation = useNavigationContainerRef();
  useEffect(() => {
    root.navigation = navigation;
  }, [navigation]);
  return null;
}

const ROUTES = {
  _layout: () => (
    <>
      <Stack />
      <RootProbe />
    </>
  ),
  index: Empty,
  "(drawer)/_layout": () => <Slot />,
  "(drawer)/(tabs)/_layout": () => (
    <Tabs>
      {TAB_ROUTES.map((route) => <Tabs.Screen key={route} name={route} />)}
    </Tabs>
  ),
  "(drawer)/(tabs)/(chats)/_layout": { default: () => <Stack />, unstable_settings: chatsSettings },
  "(drawer)/(tabs)/(chats)/index": Empty,
  "(drawer)/(tabs)/(chats)/shared": Empty,
  "(drawer)/(tabs)/(chats)/projects/index": Empty,
  "(drawer)/(tabs)/agents/_layout": () => <Stack />,
  "(drawer)/(tabs)/agents/index": Empty,
  "(drawer)/(tabs)/agents/new": Empty,
  "(drawer)/(tabs)/(apps)/_layout": { default: () => <Stack />, unstable_settings: appsSettings },
  "(drawer)/(tabs)/(apps)/apps": Empty,
  "(drawer)/(tabs)/(apps)/files": Empty,
  "(drawer)/(tabs)/(apps)/integrations": Empty,
  "(drawer)/(tabs)/terminal": Empty,
  "(drawer)/(tabs)/settings": Empty,
  // Screens the app opens above the shell, in the root stack.
  "terminal-session/_layout": () => <Stack />,
  "terminal-session/[session]": Empty,
  "settings-detail/_layout": () => <Stack />,
  "settings-detail/account": Empty,
};

type State = { key?: string; index?: number; routes: { name: string; params?: object; state?: State }[] };

let app: RenderRouterResult;

async function run(step: () => void) {
  await act(async () => {
    step();
  });
}

/**
 * Starts at the chat screen, then opens what the steps name, as the person
 * would. A first step starting with `link:` is the URL the app opened at instead.
 */
async function openApp(steps: string[]) {
  const link = steps[0]?.startsWith("link:") ? steps[0].slice(5) : null;
  app = await renderRouter(ROUTES, { initialUrl: link ?? "/(drawer)" });
  for (const step of link ? steps.slice(1) : steps) {
    await run(() => (step.startsWith("push:") ? router.push(step.slice(5) as never) : router.navigate(step as never)));
  }
}

/** The routes of the stack, tab or slot named `name`, bottom first. */
function screensIn(name: string): string[] {
  let state = app.getRouterState() as State | undefined;
  while (state) {
    const route = state.routes.find((candidate) => candidate.name === name);
    if (route) return route.state?.routes.map((child) => child.name) ?? [];
    state = state.routes[state.index ?? state.routes.length - 1]?.state;
  }
  return [];
}

/** The app's own root stack, bottom first. */
const rootStack = () => screensIn("__root");

const CHAT_SCREEN = ["(drawer)", "(tabs)", "(chats)"];

const STARTS: [string, string[]][] = [
  ["the chat screen", []],
  ["Shared with me", ["/shared"]],
  ["the Apps tab, with Shared left open in Chats", ["/shared", "/apps"]],
  ["New agent", ["/agents", "push:/agents/new"]],
  ["the Terminal tab", ["/terminal"]],
  ["a terminal above the shell", ["/shared", `push:/terminal-session/${TERMINAL}`]],
  ["a settings page above the Agents tab", ["/shared", "/agents", "push:/settings-detail/account"]],
  ["Connect Apps opened by a link, before the Chats tab was ever shown", ["link:/integrations"]],
];

describe("showChatScreenFromRoot", () => {
  it.each(STARTS)("shows the chat screen from %s, with nothing left above it", async (_start, steps) => {
    await openApp(steps);

    await run(() => showChatScreenFromRoot(root.navigation!, router));

    expect(app.getSegments()).toEqual(CHAT_SCREEN);
    expect(rootStack()).toEqual(["(drawer)"]);
    expect(screensIn("(chats)")).toEqual(["index"]);
  });

  it("never asks a navigator for a route it does not have", async () => {
    const error = jest.spyOn(console, "error");
    await openApp(["/shared", `push:/terminal-session/${TERMINAL}`]);

    await run(() => showChatScreenFromRoot(root.navigation!, router));

    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});

describe("showChatListFromRoot", () => {
  /** Records where the app was each time the side panel was asked to open. */
  function watchSidePanel(navigation: RootNavigation) {
    const dispatch = navigation.dispatch.bind(navigation);
    const openedAt: string[][] = [];
    // The stand-in side panel is a slot, which has no panel to open.
    const spy = jest.spyOn(navigation, "dispatch").mockImplementation((action) => {
      if ((action as { type: string }).type === "OPEN_DRAWER") openedAt.push([...app.getSegments()]);
      else dispatch(action);
    });
    return { openedAt, restore: () => spy.mockRestore() };
  }

  it.each(STARTS)("opens the side panel over the chat screen from %s", async (_start, steps) => {
    await openApp(steps);
    const sidePanel = watchSidePanel(root.navigation!);

    await run(() => showChatListFromRoot(root.navigation!, router));

    expect(app.getSegments()).toEqual(CHAT_SCREEN);
    expect(rootStack()).toEqual(["(drawer)"]);
    // Asked from the chat screen, the request reaches the side panel above it;
    // asked from a screen still closing, it reaches no navigator.
    expect(sidePanel.openedAt).toEqual([CHAT_SCREEN]);

    // Nothing is left waiting to open it again later.
    await run(() => router.navigate("/apps" as never));
    await run(() => showChatScreenFromRoot(root.navigation!, router));
    expect(sidePanel.openedAt).toHaveLength(1);
    sidePanel.restore();
  });
});

describe("openTerminalFromRoot", () => {
  function openTerminals(): string[] {
    const terminals = (app.getRouterState() as State).routes[0].state!.routes.find((route) => route.name === "terminal-session");
    return terminals?.state?.routes.map((route) => (route.params as { session?: string } | undefined)?.session ?? "") ?? [];
  }

  it.each(STARTS)("opens the terminal above the shell from %s", async (_start, steps) => {
    await openApp(steps);

    await run(() => openTerminalFromRoot(root.navigation!, router, OTHER_TERMINAL));

    expect(app.getSegments()).toEqual(["terminal-session", "[session]"]);
    expect(rootStack()).toEqual(["(drawer)", "terminal-session"]);
    expect(openTerminals()).toEqual([OTHER_TERMINAL]);
  });

  it("leaves the terminal on screen when it is the one the notification names", async () => {
    await openApp([`push:/terminal-session/${TERMINAL}`]);

    await run(() => openTerminalFromRoot(root.navigation!, router, TERMINAL));

    expect(rootStack()).toEqual(["(drawer)", "terminal-session"]);
    expect(openTerminals()).toEqual([TERMINAL]);
  });
});
