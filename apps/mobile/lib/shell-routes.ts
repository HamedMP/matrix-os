// Where the signed-in shell's screens sit in the route tree:
// `(drawer)` (the side panel) > `(tabs)` > one navigator per tab.

/** The side panel's only screen: the tabs. */
export const TABS_ROUTE = "(tabs)";

const CHATS_TAB_ROUTE = "(chats)";
const CHAT_SCREEN_SEGMENTS = ["(drawer)", TABS_ROUTE, CHATS_TAB_ROUTE];

/**
 * Whether `useSegments()` names the chat screen (URL `/`), the one screen the
 * side panel opens from. An index route adds no segment of its own.
 */
export function isChatScreen(segments: readonly string[]): boolean {
  return segments.length === CHAT_SCREEN_SEGMENTS.length
    && CHAT_SCREEN_SEGMENTS.every((segment, index) => segments[index] === segment);
}

// The params below go to `navigation.navigate(TABS_ROUTE, …)`, which any
// navigator inside the side panel passes up to it. They are built on each call:
// React Navigation marks a params object once it has acted on it, and ignores
// the same object the next time.

/**
 * Shows the chat screen from the side panel. The panel only opens over the
 * chat screen, so this is the screen already at the top of the Chats tab.
 */
export function chatScreenParams() {
  return { screen: CHATS_TAB_ROUTE, params: { screen: "index" } };
}

/**
 * Shows the chat screen from another tab, closing whatever was left open
 * above it in the Chats tab. `pop` then stays on the Chats route and shows up
 * as a search param (`/?pop=true`) until the next navigation there, which is
 * why the side panel does without it.
 */
export function chatScreenFromAnotherTabParams() {
  return { screen: CHATS_TAB_ROUTE, params: { screen: "index", pop: true } };
}

/** Opens "Shared with me" on top of the chat screen. */
export function sharedScreenParams() {
  return { screen: CHATS_TAB_ROUTE, params: { screen: "shared" } };
}
