interface BadgeApp {
  dock?: { setBadge(text: string): void };
  setBadgeCount(count: number): unknown;
}

export function setNativeChatBadge(app: BadgeApp, platform: string, unreadCount: number): void {
  if (platform === "darwin" && app.dock) {
    // A nonempty blank label keeps the native red badge visible without a number.
    // An empty label removes it. macOS owns the badge's shape and placement.
    app.dock.setBadge(unreadCount > 0 ? " " : "");
    return;
  }
  app.setBadgeCount(unreadCount);
}
