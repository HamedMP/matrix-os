import type { useNavigationContainerRef } from "expo-router";
import { DrawerActions, StackActions } from "expo-router/react-navigation";

import { CHATS_TAB_ROUTE, CHAT_SCREEN_HREF } from "@/lib/shell-routes";

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

/** Shows the chat screen with the side panel, which lists the chats, open over it. */
export function showChatListFromRoot(navigation: RootNavigation, router: Router): void {
  const sidePanel = rootStack(navigation)?.routes.find((route) => route.name === SHELL_ROUTE)?.state?.key;
  showChatScreenFromRoot(navigation, router);
  if (sidePanel) navigation.dispatch({ ...DrawerActions.openDrawer(), target: sidePanel });
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
