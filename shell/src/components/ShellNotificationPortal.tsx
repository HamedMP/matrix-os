"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  getShellNotificationHostServerSnapshot,
  getShellNotificationHostSnapshot,
  subscribeShellNotificationHost,
} from "./shell-notification-host";
import {
  ShellNotificationStack,
} from "./ShellNotificationStack";

export function ShellNotificationPortal({ children }: { children: ReactNode }) {
  const host = useSyncExternalStore(
    subscribeShellNotificationHost,
    getShellNotificationHostSnapshot,
    getShellNotificationHostServerSnapshot,
  );

  if (host) return createPortal(children, host);

  return (
    <ShellNotificationStack registerHost={false}>
      {children}
    </ShellNotificationStack>
  );
}
