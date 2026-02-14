"use client";

import type { UIStatusData } from "@/lib/ui-blocks";
import {
  InfoIcon,
  CheckCircleIcon,
  AlertTriangleIcon,
  XCircleIcon,
} from "lucide-react";

const levelConfig = {
  info: {
    icon: InfoIcon,
    className: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
  },
  success: {
    icon: CheckCircleIcon,
    className: "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300",
  },
  warning: {
    icon: AlertTriangleIcon,
    className: "border-yellow-500/30 bg-yellow-500/10 text-yellow-700 dark:text-yellow-300",
  },
  error: {
    icon: XCircleIcon,
    className: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
  },
};

interface StatusBannerProps {
  status: UIStatusData;
}

export function StatusBanner({ status }: StatusBannerProps) {
  const config = levelConfig[status.level] ?? levelConfig.info;
  const Icon = config.icon;

  return (
    <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 my-2 text-sm ${config.className}`}>
      <Icon className="size-4 shrink-0" />
      <span>{status.message}</span>
    </div>
  );
}
