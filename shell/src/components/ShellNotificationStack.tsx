"use client";

import type { ReactNode } from "react";
import { SHELL_NOTIFICATION_STACK_ID, setShellNotificationHost } from "./shell-notification-host";

export function ShellNotificationStack({
  children,
  registerHost = true,
}: {
  children: ReactNode;
  registerHost?: boolean;
}) {
  return (
    <div
      ref={(node) => {
        if (registerHost) setShellNotificationHost(node);
      }}
      id={SHELL_NOTIFICATION_STACK_ID}
      data-testid="shell-notification-stack"
      className="pointer-events-none fixed right-3 top-[calc(env(safe-area-inset-top)+0.75rem)] z-[10000] flex w-[calc(100vw-1.5rem)] max-w-[min(92vw,560px)] flex-col items-end gap-2 md:top-9"
    >
      {children}
    </div>
  );
}
