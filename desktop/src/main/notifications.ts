interface NotificationLike {
  on(event: "click", listener: () => void): unknown;
  on(event: "failed", listener: (event: unknown, error: string) => void): unknown;
  show(): void;
}

interface NotificationConstructor {
  new (options: { title: string; body: string; silent?: boolean }): NotificationLike;
  isSupported(): boolean;
}

export function showDesktopNotification(
  Notification: NotificationConstructor,
  content: { title: string; body: string },
  options: { onClick?: () => void } = {},
): void {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title: content.title, body: content.body, silent: false });
  if (options.onClick) notification.on("click", options.onClick);
  // macOS UNNotification (Electron 42+) reports `failed` for unsigned builds
  // and denied permission. The OS error can echo the content, so log the kind only.
  notification.on("failed", () => {
    console.warn("[notifications] delivery failed", { platform: process.platform });
  });
  notification.show();
}
