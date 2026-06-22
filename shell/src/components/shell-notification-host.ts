export const SHELL_NOTIFICATION_STACK_ID = "shell-notification-stack-root";

let shellNotificationHost: HTMLElement | null = null;
let shellNotificationListeners: Array<() => void> = [];

export function setShellNotificationHost(host: HTMLElement | null): void {
  if (shellNotificationHost === host) return;
  shellNotificationHost = host;
  for (const listener of shellNotificationListeners) listener();
}

export function subscribeShellNotificationHost(listener: () => void): () => void {
  shellNotificationListeners = [...shellNotificationListeners, listener];
  return () => {
    shellNotificationListeners = shellNotificationListeners.filter((candidate) => candidate !== listener);
  };
}

export function getShellNotificationHostSnapshot(): HTMLElement | null {
  return shellNotificationHost;
}

export function getShellNotificationHostServerSnapshot(): null {
  return null;
}
