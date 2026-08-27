"use client";

import { useEffect, useRef, useState } from "react";
import { Copy, ExternalLink, Link2, X } from "@/lib/hugeicons";

import type { TerminalLinkEntry, TerminalLinksState } from "./terminal-links";

const AUTO_COLLAPSE_MS = 8_000;

interface TerminalLinksTrayProps {
  state: TerminalLinksState;
  onCollapse: () => void;
  onDismiss: () => void;
  onOpen: (link: TerminalLinkEntry) => void;
  onCopy: (link: TerminalLinkEntry) => void;
}

function linkTitle(link: TerminalLinkEntry): string {
  return link.kind === "web"
    ? link.hostname
    : `${link.providerLabel} sign-in`;
}

function linkDescription(link: TerminalLinkEntry): string {
  return `${link.hostname}${link.displayPath === "/" ? "" : link.displayPath}`;
}

function openLabel(link: TerminalLinkEntry): string {
  return link.kind === "web"
    ? `Open ${link.hostname}`
    : `Sign in with ${link.providerLabel}`;
}

export function TerminalLinksTray({
  state,
  onCollapse,
  onDismiss,
  onOpen,
  onCopy,
}: TerminalLinksTrayProps) {
  const [listOpen, setListOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const firstListActionRef = useRef<HTMLButtonElement>(null);
  const active = state.entries.find((entry) => entry.url === state.activeUrl) ?? state.entries[0];

  useEffect(() => {
    if (state.presentation !== "expanded" || !state.activeUrl) return;
    const timer = window.setTimeout(onCollapse, AUTO_COLLAPSE_MS);
    return () => window.clearTimeout(timer);
  }, [onCollapse, state.activeUrl, state.presentation]);

  useEffect(() => {
    if (!listOpen) return;
    firstListActionRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setListOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [listOpen]);

  if (state.presentation === "hidden" || !active) return null;

  const closeList = () => {
    setListOpen(false);
    triggerRef.current?.focus();
  };
  const perform = (
    action: (link: TerminalLinkEntry) => void,
    link: TerminalLinkEntry,
  ) => {
    action(link);
    closeList();
    onCollapse();
  };
  const toggleList = () => setListOpen((open) => !open);

  return (
    <div
      className="absolute right-2 top-2 z-30 max-w-[calc(100%-16px)] font-sans"
      style={{ width: state.presentation === "expanded" ? "min(420px, calc(100% - 16px))" : "auto" }}
    >
      {state.presentation === "expanded" ? (
        <div
          role="status"
          aria-live="polite"
          className="flex min-h-14 w-full items-center gap-2 rounded-xl border border-border/70 bg-card/95 p-2 text-foreground shadow-lg backdrop-blur-md"
          style={{ maxWidth: "min(420px, calc(100% - 16px))" }}
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Link2 aria-hidden="true" className="size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold leading-5">{linkTitle(active)}</span>
            <span className="block truncate text-xs leading-4 text-muted-foreground">
              {linkDescription(active)}
            </span>
          </span>
          <button
            type="button"
            aria-label={openLabel(active)}
            onClick={() => perform(onOpen, active)}
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ExternalLink aria-hidden="true" className="size-3.5" />
            {active.kind === "web" ? "Open" : "Sign in"}
          </button>
          <button
            type="button"
            aria-label="Copy link"
            title="Copy link"
            onClick={() => perform(onCopy, active)}
            className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/70 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Copy aria-hidden="true" className="size-4" />
          </button>
          {state.entries.length > 1 && (
            <button
              ref={triggerRef}
              type="button"
              aria-label={`Show ${state.entries.length} terminal links`}
              aria-expanded={listOpen}
              onClick={toggleList}
              className="h-9 shrink-0 rounded-lg px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {state.entries.length} links
            </button>
          )}
          <button
            type="button"
            aria-label="Dismiss terminal links"
            title="Dismiss"
            onClick={onDismiss}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>
      ) : (
        <div className="ml-auto flex w-max items-center rounded-full border border-border/70 bg-card/95 p-1 text-foreground shadow-md backdrop-blur-md">
          <button
            ref={triggerRef}
            type="button"
            aria-label={`Show ${state.entries.length} terminal links`}
            aria-expanded={listOpen}
            onClick={toggleList}
            className="inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-xs font-semibold transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Link2 aria-hidden="true" className="size-3.5 text-primary" />
            Links · {state.entries.length}
          </button>
          <button
            type="button"
            aria-label="Dismiss terminal links"
            title="Dismiss"
            onClick={onDismiss}
            className="inline-flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X aria-hidden="true" className="size-3.5" />
          </button>
        </div>
      )}

      {listOpen && (
        <div
          role="dialog"
          aria-label="Terminal links"
          className="absolute right-0 top-[calc(100%+6px)] w-[min(360px,calc(100vw-24px))] overflow-hidden rounded-xl border border-border/70 bg-card text-card-foreground shadow-xl"
        >
          <div className="border-b border-border/60 px-3 py-2 text-xs text-muted-foreground">
            Links come from terminal output. Open only what you trust.
          </div>
          <div className="max-h-64 overflow-y-auto p-1.5">
            {state.entries.map((entry, index) => (
              <div
                key={entry.url}
                data-testid="terminal-link-row"
                className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-muted/70"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-semibold">
                    {entry.kind === "web" ? entry.hostname : entry.providerLabel}
                  </span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {entry.displayPath}
                  </span>
                </span>
                <button
                  ref={index === 0 ? firstListActionRef : undefined}
                  type="button"
                  aria-label={openLabel(entry)}
                  onClick={() => perform(onOpen, entry)}
                  className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ExternalLink aria-hidden="true" className="size-3.5" />
                </button>
                <button
                  type="button"
                  aria-label={`Copy ${entry.url}`}
                  onClick={() => perform(onCopy, entry)}
                  className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Copy aria-hidden="true" className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
