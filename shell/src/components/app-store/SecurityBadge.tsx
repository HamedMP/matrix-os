"use client";

import { ShieldCheckIcon, ShieldAlertIcon, ClockIcon } from "lucide-react";

interface SecurityBadgeProps {
  status: "passed" | "pending" | "failed";
  size?: "sm" | "md";
}

export function SecurityBadge({ status, size = "sm" }: SecurityBadgeProps) {
  const isSmall = size === "sm";
  const iconSize = isSmall ? "size-3" : "size-4";

  if (status === "passed") {
    return (
      <span className={`inline-flex items-center gap-1 ${isSmall ? "text-[10px]" : "text-xs"} text-green-600`}>
        <ShieldCheckIcon className={iconSize} />
        <span>Verified</span>
      </span>
    );
  }

  if (status === "pending") {
    return (
      <span className={`inline-flex items-center gap-1 ${isSmall ? "text-[10px]" : "text-xs"} text-amber-500`}>
        <ClockIcon className={iconSize} />
        <span>Pending review</span>
      </span>
    );
  }

  return (
    <span className={`inline-flex items-center gap-1 ${isSmall ? "text-[10px]" : "text-xs"} text-red-500`}>
      <ShieldAlertIcon className={iconSize} />
      <span>Audit failed</span>
    </span>
  );
}
