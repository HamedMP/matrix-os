// Where the signed-in shell's screens sit in the route tree:
// `(drawer)` (the side panel) > `(tabs)` > one navigator per tab.

/** The side panel's only screen: the tabs. */
export const TABS_ROUTE = "(tabs)";

/** The Chats tab, which holds the chat screen. */
export const CHATS_TAB_ROUTE = "(chats)";
const CHAT_SCREEN_SEGMENTS = ["(drawer)", TABS_ROUTE, CHATS_TAB_ROUTE];

/**
 * Whether `useSegments()` names the chat screen (URL `/`), the one screen the
 * side panel opens from. An index route adds no segment of its own.
 */
export function isChatScreen(segments: readonly string[]): boolean {
  return segments.length === CHAT_SCREEN_SEGMENTS.length
    && CHAT_SCREEN_SEGMENTS.every((segment, index) => segments[index] === segment);
}

// The router's `navigate` switches to the tab that holds an href's screen and
// pushes the screen onto that tab's stack; `dismissTo` closes what is open
// above a screen already in the current stack.

/**
 * The chat screen: the first screen of the Chats tab. Its URL is `/`, which
 * the sign-in gate (`app/index.tsx`) also answers to, so the href names the
 * side panel's group to reach the chat screen instead.
 */
export const CHAT_SCREEN_HREF = "/(drawer)";

/** "Shared with me", on top of the chat screen in the Chats tab. */
export const SHARED_SCREEN_HREF = "/shared";

/** Projects, on top of the chat screen in the Chats tab. */
export const PROJECTS_SCREEN_HREF = "/projects";

/** The Terminal or Settings tab. Each is a single screen. */
export function tabScreenHref(tab: "terminal" | "settings") {
  return `/${tab}` as const;
}
