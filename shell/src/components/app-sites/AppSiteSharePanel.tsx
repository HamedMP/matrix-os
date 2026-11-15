"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { SiteClient } from "../../lib/site-client";
import { AppSitePanel } from "./AppSitePanel";

/** A compact row in the sharing options that opens its details in the same popover. */
export interface AppSiteShareDetails {
  /** Row content; its text is the row's accessible name, so it must state the current status. */
  summary: ReactNode;
  title: string;
  /** Mounted only while the details are open. */
  content: ReactNode;
}

type Direction = "forward" | "back";

const MUTED = "var(--muted-foreground, var(--text-secondary, GrayText))";
const BORDER = "var(--border, var(--border-default, color-mix(in srgb, CanvasText 18%, transparent)))";
const ENTER_EASE = "cubic-bezier(0.23, 1, 0.32, 1)";

/**
 * Forward enters from the right and back from the left, so the two views read as one space.
 * Reduced motion keeps the change legible with a fade and moves nothing.
 */
function animateShareViewEntrance(element: HTMLElement | null, direction: Direction): void {
  if (!element || typeof element.animate !== "function") return;
  const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const offset = direction === "forward" ? 8 : -8;
  for (const animation of element.getAnimations?.() ?? []) animation.cancel();
  element.animate(
    reduce
      ? [{ opacity: 0 }, { opacity: 1 }]
      : [{ opacity: 0, transform: `translateX(${offset}px)` }, { opacity: 1, transform: "translateX(0)" }],
    { duration: reduce ? 140 : 180, easing: ENTER_EASE },
  );
}

function Icon({ path }: { path: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d={path} />
    </svg>
  );
}

const ICON_BUTTON = "inline-flex size-7 shrink-0 items-center justify-center rounded-md transition-[background-color,transform] duration-150 ease-out hover:bg-[color-mix(in_srgb,currentColor_8%,transparent)] active:scale-[0.97] motion-reduce:active:scale-100 focus-visible:outline-2 focus-visible:outline-offset-2";

export function AppSiteSharePanel({
  appSlug,
  client,
  ownerIdentity,
  onClose,
  organizationSharing,
}: {
  appSlug: string;
  client: SiteClient;
  ownerIdentity: string;
  onClose: () => void;
  organizationSharing?: AppSiteShareDetails;
}) {
  const [view, setView] = useState<"overview" | "details">("overview");
  const navigation = useRef<Direction | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const overviewRef = useRef<HTMLDivElement>(null);
  const detailsRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const summaryRef = useRef<HTMLButtonElement>(null);
  const details = view === "details" && organizationSharing ? organizationSharing : null;

  // Runs before paint so the entrance starts from its first frame and focus lands on the new view.
  useLayoutEffect(() => {
    const direction = navigation.current;
    if (!direction) return;
    navigation.current = null;
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
    (direction === "forward" ? titleRef : summaryRef).current?.focus({ preventScroll: true });
    animateShareViewEntrance(direction === "forward" ? detailsRef.current : overviewRef.current, direction);
  }, [view]);

  const navigate = (next: "overview" | "details") => {
    navigation.current = next === "details" ? "forward" : "back";
    setView(next);
  };

  return (
    <section
      style={{
        maxHeight: "inherit",
        background: "var(--background, var(--bg-surface, Canvas))",
        color: "var(--foreground, var(--text-primary, CanvasText))",
      }}
      className="flex min-h-0 w-full flex-col overflow-hidden rounded-lg"
    >
      <header className="flex shrink-0 items-start justify-between gap-2 border-b px-3 py-2.5" style={{ borderColor: BORDER }}>
        {details ? (
          <div className="flex min-w-0 items-center gap-1.5">
            <button type="button" aria-label="Back to sharing options" onClick={() => navigate("overview")}
              className={`-ml-1 ${ICON_BUTTON}`} style={{ color: MUTED }}>
              <Icon path="M10 3.5 5.5 8l4.5 4.5" />
            </button>
            <h2 ref={titleRef} tabIndex={-1} className="truncate text-sm font-semibold tracking-[-0.01em] outline-none">
              {details.title}
            </h2>
          </div>
        ) : (
          <div className="min-w-0">
            <h2 className="text-sm font-semibold tracking-[-0.01em]">Share app</h2>
            <p className="mt-1 text-xs leading-5" style={{ color: MUTED }}>
              {organizationSharing ? "Invite by link, publish at a URL, or share with your organization." : "Create a one-time invite link, or publish at a stable URL."}
            </p>
          </div>
        )}
        <button type="button" aria-label="Close sharing" onClick={onClose} className={`-mr-1 ${ICON_BUTTON}`} style={{ color: MUTED }}>
          <Icon path="M4 4l8 8M12 4l-8 8" />
        </button>
      </header>
      <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
        {/* The overview stays mounted while hidden so invite and publication state survive navigation. */}
        <div ref={overviewRef} hidden={Boolean(details)}>
          {organizationSharing ? (
            <button
              ref={summaryRef}
              type="button"
              onClick={() => navigate("details")}
              className="mb-3 flex w-full items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left text-[13px] transition-[background-color,transform] duration-150 ease-out hover:bg-[color-mix(in_srgb,currentColor_5%,transparent)] active:scale-[0.99] motion-reduce:active:scale-100 focus-visible:outline-2 focus-visible:outline-offset-2"
              style={{ borderColor: BORDER }}
            >
              <span className="flex min-w-0 flex-1 items-center gap-2.5">{organizationSharing.summary}</span>
              <span className="shrink-0" style={{ color: MUTED }}><Icon path="M6 3.5 10.5 8 6 12.5" /></span>
            </button>
          ) : null}
          <AppSitePanel appSlug={appSlug} client={client} variant="share" ownerIdentity={ownerIdentity} />
        </div>
        {details ? <div ref={detailsRef}>{details.content}</div> : null}
      </div>
    </section>
  );
}
