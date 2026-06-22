"use client";

import type { ComponentPropsWithoutRef } from "react";

export function ShellNotificationCard({
  children,
  className,
  ...props
}: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={[
        "pointer-events-auto w-full max-w-[min(92vw,560px)]",
        className,
      ].filter(Boolean).join(" ")}
      {...props}
    >
      {children}
    </div>
  );
}
