"use client";

import type { ReactNode } from "react";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";
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
      ref={registerHost ? setShellNotificationHost : undefined}
      id={registerHost ? SHELL_NOTIFICATION_STACK_ID : undefined}
      data-testid="shell-notification-stack"
      className="pointer-events-none fixed right-3 top-[calc(env(safe-area-inset-top)+0.75rem)] flex w-[calc(100vw-1.5rem)] max-w-[min(92vw,560px)] flex-col items-end gap-2 md:top-9"
      style={{ zIndex: SHELL_Z_INDEX.notifications }}
    >
      {children}
    </div>
  );
}
