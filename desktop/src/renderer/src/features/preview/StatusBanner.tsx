import React, { type ReactNode } from "react";
/** Slim top-of-window identity strip shared by preview-pair and dev-run banners. */
export function StatusBanner({ children }: { children: ReactNode }) {
  return <div role="status" className="shrink-0 border-b px-4 py-2 text-xs" style={{ borderColor: "var(--border-default)", background: "var(--bg-overlay)", color: "var(--text-primary)" }}>
    {children}
  </div>;
}
