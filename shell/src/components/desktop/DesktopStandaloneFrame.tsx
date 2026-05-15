"use client";

import type { ReactNode } from "react";
import { useDesktopConfig } from "@/hooks/useDesktopConfig";
import { useTheme } from "@/hooks/useTheme";

interface DesktopStandaloneFrameProps {
  children: ReactNode;
  className?: string;
}

export function DesktopStandaloneFrame({ children, className }: DesktopStandaloneFrameProps) {
  useTheme();
  useDesktopConfig();

  return (
    <div className={`h-screen w-screen overflow-hidden bg-background text-foreground ${className ?? ""}`}>
      {children}
    </div>
  );
}
