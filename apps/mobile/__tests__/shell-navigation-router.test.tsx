// Drives Expo Router's own navigators over a stand-in of the shell's route
// tree, with the stack anchors the app's layouts export, to check that the side
// panel's hrefs and the shell navigation hooks land where the app expects.
import { act } from "@testing-library/react-native";
import { useEffect } from "react";
import { router, Slot, Stack } from "expo-router";
import { Tabs } from "expo-router/tabs";
import { renderRouter, type RenderRouterResult } from "expo-router/testing-library";

import { unstable_settings as appsSettings } from "../app/(drawer)/(tabs)/(apps)/_layout";
import { unstable_settings as chatsSettings } from "../app/(drawer)/(tabs)/(chats)/_layout";
import {
  CHAT_SCREEN_HREF,
  PROJECTS_SCREEN_HREF,
  SHARED_SCREEN_HREF,
} from "../lib/shell-routes";
import { useShowChatScreen, useShowTab } from "../lib/use-shell-navigation";

// The Chats layout's provider loads Clerk, whose import opens a MessagePort
// that keeps Jest from exiting. Only the layouts' settings are read here.
jest.mock("@/components/chat/active-chat", () => ({
  ActiveChatProvider: ({ children }: { children: unknown }) => children,
}));

const Empty = () => null;
const TAB_ROUTES = ["(chats)", "agents", "(apps)", "terminal", "settings"];

/** What the Apps screen's shortcuts call, taken from the hooks while it is mounted. */
const apps: { showChatScreen?: () => void; showTab?: ReturnType<typeof useShowTab> } = {};

function AppsScreen() {
  const showChatScreen = useShowChatScreen();
  const showTab = useShowTab();
  useEffect(() => {
    apps.showChatScreen = showChatScreen;
    apps.showTab = showTab;
  }, [showChatScreen, showTab]);
  return null;
}

const ROUTES = {
  _layout: () => <Stack />,
  index: Empty,
  // The side panel only wraps the tabs; a slot keeps its one screen.
  "(drawer)/_layout": () => <Slot />,
  // The tabs show the screens their layout declares, as the app's layout does.
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
  "(drawer)/(tabs)/(apps)/apps": AppsScreen,
  "(drawer)/(tabs)/(apps)/files": Empty,
  "(drawer)/(tabs)/(apps)/integrations": Empty,
  "(drawer)/(tabs)/terminal": Empty,
  "(drawer)/(tabs)/settings": Empty,
};

type State = { index?: number; routes: { name: string; state?: State }[] };

let app: RenderRouterResult;

/** Starts the app at `initialUrl`, as a launch or a link would. */
async function open(initialUrl: string) {
  app = await renderRouter(ROUTES, { initialUrl });
}

/** The screens in a tab's own stack, bottom first. */
function tabStack(tab: string): string[] {
  let state = app.getRouterState() as State | undefined;
  while (state) {
    const route = state.routes.find((candidate) => candidate.name === tab);
    if (route) return route.state?.routes.map((child) => child.name) ?? [];
    state = state.routes[state.index ?? state.routes.length - 1]?.state;
  }
  return [];
}

async function run(step: () => void) {
  await act(async () => {
    step();
  });
}

const CHAT_SCREEN = ["(drawer)", "(tabs)", "(chats)"];

describe("shell navigation", () => {
  it("opens the sign-in gate at the root URL, not the chat screen that shares it", async () => {
    await open("/");
    expect(app.getSegments()).toEqual([]);
  });

  describe("from the side panel, which opens over the chat screen", () => {
    it("opens Projects above the chat screen", async () => {
      await open(CHAT_SCREEN_HREF);

      await run(() => router.navigate(PROJECTS_SCREEN_HREF as never));

      expect(app.getSegments()).toEqual([...CHAT_SCREEN, "projects"]);
      expect(tabStack("(chats)")).toEqual(["index", "projects/index"]);
    });

    it("opens Shared with me above the chat screen", async () => {
      await open(CHAT_SCREEN_HREF);

      await run(() => router.navigate(SHARED_SCREEN_HREF as never));

      expect(app.getSegments()).toEqual([...CHAT_SCREEN, "shared"]);
      expect(tabStack("(chats)")).toEqual(["index", "shared"]);
    });

    it("stays on the chat screen it opened over", async () => {
      await open(CHAT_SCREEN_HREF);

      await run(() => router.dismissTo(CHAT_SCREEN_HREF as never));

      expect(app.getSegments()).toEqual(CHAT_SCREEN);
      expect(tabStack("(chats)")).toEqual(["index"]);
    });
  });

  describe("from the Apps tab", () => {
    it("shows the chat screen, closing what was left open above it", async () => {
      await open(CHAT_SCREEN_HREF);
      await run(() => router.navigate(SHARED_SCREEN_HREF as never));
      await run(() => router.navigate("/apps" as never));

      await run(() => apps.showChatScreen!());

      expect(app.getSegments()).toEqual(CHAT_SCREEN);
      expect(tabStack("(chats)")).toEqual(["index"]);
    });

    it("shows the chat screen when the Chats tab has not been opened yet", async () => {
      await open("/apps");

      await run(() => apps.showChatScreen!());

      expect(app.getSegments()).toEqual(CHAT_SCREEN);
      expect(tabStack("(chats)")).toEqual(["index"]);
    });

    it("switches to the Terminal and Settings tabs", async () => {
      await open("/apps");

      await run(() => apps.showTab!("settings"));
      expect(app.getSegments()).toEqual(["(drawer)", "(tabs)", "settings"]);

      await run(() => router.navigate("/apps" as never));
      await run(() => apps.showTab!("terminal"));
      expect(app.getSegments()).toEqual(["(drawer)", "(tabs)", "terminal"]);
    });
  });

  describe("links that open a screen directly", () => {
    it("put the chat screen beneath a Chats screen", async () => {
      await open(SHARED_SCREEN_HREF);

      expect(app.getSegments()).toEqual([...CHAT_SCREEN, "shared"]);
      expect(tabStack("(chats)")).toEqual(["index", "shared"]);
    });

    it("leave Apps beneath Files", async () => {
      await open("/files");

      expect(tabStack("(apps)")).toEqual(["apps", "files"]);
    });

    it("leave Apps beneath Connect Apps, where its sign-in returns through matrixos://integrations", async () => {
      await open("/integrations");

      expect(tabStack("(apps)")).toEqual(["apps", "integrations"]);
    });
  });

  it("names the screen open inside a tab in the segments the tab bar reads", async () => {
    await open("/agents/new");

    expect(app.getSegments()).toEqual(["(drawer)", "(tabs)", "agents", "new"]);
  });
});
