/**
 * Screens that take the whole display: for each tab's route (`agents`), the
 * route names inside that tab's own navigator (`new`, `[agentId]`). The tab
 * bar is hidden while one of them is focused.
 */
export const TAB_BAR_HIDDEN_ROUTES: Readonly<Record<string, readonly string[]>> = {
  agents: ["new", "[agentId]"],
};

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

/**
 * The screen focused inside a tab's own navigator, read from `useSegments()`:
 * the segment after the tab's route. A tab's index screen adds no segment of
 * its own, so it reads as `undefined`, as does a tab that is a single screen.
 */
export function focusedNestedRouteName(segments: readonly string[], tabRoute: string): string | undefined {
  const tabIndex = segments.indexOf(tabRoute);
  return tabIndex === -1 ? undefined : segments[tabIndex + 1];
}
