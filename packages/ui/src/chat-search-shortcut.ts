import { useEffect } from "react";

const CHAT_SEARCH_REQUEST = "matrix:chat-search-request";

/** The global keyboard owner offers Cmd/Ctrl-K to the active Chat first. */
export function requestChatSearchShortcut(): boolean {
  return !window.dispatchEvent(new Event(CHAT_SEARCH_REQUEST, { cancelable: true }));
}

/** Only the active Chat claims a request; unmount/surface changes remove it. */
export function useChatSearchShortcut(active: boolean, onSearch: () => void): void {
  useEffect(() => {
    if (!active) return;
    const openSearch = (event: Event) => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      onSearch();
    };
    window.addEventListener(CHAT_SEARCH_REQUEST, openSearch);
    return () => window.removeEventListener(CHAT_SEARCH_REQUEST, openSearch);
  }, [active, onSearch]);
}

export function chatSearchShortcutLabel(platform = typeof navigator === "undefined" ? "" : navigator.platform): string {
  return /^(Mac|iPhone|iPad|iPod)/i.test(platform) ? "⌘K" : "Ctrl+K";
}
