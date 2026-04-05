"use client";

import { ArrowUpCircleIcon } from "lucide-react";

interface UpdateBadgeProps {
  currentVersion: string;
  installedVersion: string;
  size?: "sm" | "md";
}

export function UpdateBadge({ currentVersion, installedVersion, size = "sm" }: UpdateBadgeProps) {
  const isSmall = size === "sm";
  const iconSize = isSmall ? "size-3" : "size-4";

  return (
    <span className={`inline-flex items-center gap-1 ${isSmall ? "text-[10px]" : "text-xs"} text-blue-500`}>
      <ArrowUpCircleIcon className={iconSize} />
      <span>Update: {installedVersion} &rarr; {currentVersion}</span>
    </span>
  );
}
