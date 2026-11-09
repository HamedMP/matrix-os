"use client";

import type { SiteClient } from "../../lib/site-client";
import { AppSitePanel } from "./AppSitePanel";

export function AppSiteSharePanel({
  appSlug,
  client,
  onClose,
}: {
  appSlug: string;
  client: SiteClient;
  onClose: () => void;
}) {
  return (
    <section
      style={{
        height: "100%",
        background: "var(--background, var(--bg-surface, Canvas))",
        color: "var(--foreground, var(--text-primary, CanvasText))",
      }}
      className="flex min-h-0 w-full flex-col overflow-hidden rounded-xl"
    >
      <header
        className="flex shrink-0 items-start justify-between gap-4 border-b px-4 py-3.5"
        style={{ borderColor: "var(--border, var(--border-default, color-mix(in srgb, CanvasText 18%, transparent)))" }}
      >
        <div className="min-w-0">
          <h2 className="text-base font-semibold tracking-[-0.01em]">Share app</h2>
          <p className="mt-1 text-xs leading-5" style={{ color: "var(--muted-foreground, var(--text-secondary, GrayText))" }}>
            Create a one-time invite link, or publish the app at a stable URL.
          </p>
        </div>
        <button
          type="button"
          aria-label="Close sharing"
          onClick={onClose}
          className="-mr-1 inline-flex size-7 shrink-0 items-center justify-center rounded-md text-lg leading-none transition-colors"
          style={{ color: "var(--muted-foreground, var(--text-secondary, GrayText))" }}
        >
          ×
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
        <AppSitePanel appSlug={appSlug} client={client} variant="share" />
      </div>
    </section>
  );
}
