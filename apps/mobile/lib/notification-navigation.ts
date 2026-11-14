import type { useNavigationContainerRef } from "expo-router";
import { DrawerActions, StackActions } from "expo-router/react-navigation";

import { CHATS_TAB_ROUTE, CHAT_SCREEN_HREF, TABS_ROUTE } from "@/lib/shell-routes";

// A notification is opened from the root layout, where any screen may be open:
// a tab, a screen pushed inside one, or a screen the root stack shows above the
// whole shell (a terminal, a settings page).

export type RootNavigation = ReturnType<typeof useNavigationContainerRef>;
type Router = typeof import("expo-router").router;

/** The signed-in shell: the side panel and the tabs under it. */
const SHELL_ROUTE = "(drawer)";
const TERMINAL_SESSION_ROUTE = "terminal-session";

interface RouteState {
  key?: string;
  index?: number;
  routes: { name: string; params?: object; state?: RouteState }[];
}

/** The app's own root stack: Expo Router keeps it under a `__root` route of its container. */
function rootStack(navigation: RootNavigation): RouteState | undefined {
  const container = navigation.getRootState() as RouteState | undefined;
  return container?.routes.find((route) => route.name === "__root")?.state ?? container;
}

function focusedRoute(stack: RouteState | undefined) {
  return stack?.routes[stack.index ?? stack.routes.length - 1];
}

/** Shows the chat screen, closing whatever is open above it, in its tab or over the shell. */
export function showChatScreenFromRoot(navigation: RootNavigation, router: Router): void {
  // Inside the shell, the tab switch goes by name so the Chats tab keeps its
  // stack, which the dismiss then closes. Over the shell, the dismiss closes
  // the screen and switches the tab itself; a switch by name would reach only
  // the root stack, which has no such route.
  if (focusedRoute(rootStack(navigation))?.name === SHELL_ROUTE) {
    navigation.navigate(CHATS_TAB_ROUTE as never);
  }
  router.dismissTo(CHAT_SCREEN_HREF as never);
}

/** The chat screen, as the routes focused from the root down name it. */
const CHAT_SCREEN_ROUTES = [SHELL_ROUTE, TABS_ROUTE, CHATS_TAB_ROUTE, "index"];
/**
 * How long the side panel waits for the chat screen before giving up on
 * opening. A Chats tab shown for the first time can take seconds to mount on
 * a slow phone.
 */
const SIDE_PANEL_WAIT_MS = 10_000;

function isChatScreenFocused(navigation: RootNavigation): boolean {
  let state = rootStack(navigation);
  for (const name of CHAT_SCREEN_ROUTES) {
    const route = focusedRoute(state);
    if (route?.name !== name) return false;
    state = route.state;
  }
  return true;
}

/** Shows the chat screen with the side panel, which lists the chats, open over it. */
export function showChatListFromRoot(navigation: RootNavigation, router: Router): void {
  // The request to open the side panel goes to the focused screen and climbs
  // from there, so it is sent once the chat screen under the panel is focused.
  const openSidePanel = () => navigation.dispatch(DrawerActions.openDrawer());
  if (isChatScreenFocused(navigation)) {
    openSidePanel();
    return;
  }
  const stopWaiting = () => {
    clearTimeout(timer);
    unsubscribe();
  };
  const unsubscribe = navigation.addListener("state", () => {
    if (!isChatScreenFocused(navigation)) return;
    stopWaiting();
    openSidePanel();
  });
  const timer = setTimeout(stopWaiting, SIDE_PANEL_WAIT_MS);
  showChatScreenFromRoot(navigation, router);
}

/** Opens a terminal tab above the shell, closing any other screen open there first. */
export function openTerminalFromRoot(navigation: RootNavigation, router: Router, session: string): void {
  const stack = rootStack(navigation);
  const focused = focusedRoute(stack);
  if (focused?.name === TERMINAL_SESSION_ROUTE) {
    const shownSession = focusedRoute(focused.state)?.params as { session?: unknown } | undefined;
    if (shownSession?.session === session) return;
  }
  if (stack?.key && focused && focused.name !== SHELL_ROUTE) {
    navigation.dispatch({ ...StackActions.popTo(SHELL_ROUTE), target: stack.key });
  }
  router.push({ pathname: "/terminal-session/[session]", params: { session } } as never);
}
