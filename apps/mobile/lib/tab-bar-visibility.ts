/**
 * Screens that take the whole display: for each tab's route (`agents`), the
 * route names inside that tab's own navigator (`new`, `[agentId]`). The tab
 * bar is hidden while one of them is focused.
 */
export const TAB_BAR_HIDDEN_ROUTES: Readonly<Record<string, readonly string[]>> = {};

/**
 * Whether the tab bar is hidden for the focused tab (`routeName`) and the
 * screen focused inside that tab's own navigator (`nestedRouteName`).
 */
export function isTabBarHidden(
  routeName: string,
  nestedRouteName: string | undefined,
  hiddenRoutes: Readonly<Record<string, readonly string[]>> = TAB_BAR_HIDDEN_ROUTES,
): boolean {
  if (nestedRouteName === undefined || !Object.hasOwn(hiddenRoutes, routeName)) return false;
  return hiddenRoutes[routeName].includes(nestedRouteName);
}

interface NestedNavigationState {
  index?: number;
  type?: string;
  routes: readonly { name: string }[];
}

export interface RouteWithNestedState {
  state?: NestedNavigationState;
  params?: object;
}

/**
 * The screen focused inside a route's own navigator, read from the navigator
 * state a tab bar receives. Before that navigator has rendered there is no
 * state yet, only the `screen` it was asked to open.
 */
export function focusedNestedRouteName(route: RouteWithNestedState): string | undefined {
  const { state } = route;
  if (state) {
    // A state restored from a link has no index: a stack then shows its last
    // route, any other navigator its first.
    const fallbackIndex = state.type !== undefined && state.type !== "stack" ? 0 : state.routes.length - 1;
    return state.routes[state.index ?? fallbackIndex]?.name;
  }
  const screen = (route.params as { screen?: unknown } | undefined)?.screen;
  return typeof screen === "string" ? screen : undefined;
}
