"use client";

import { useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Trash2Icon } from "lucide-react";

import { SHELL_Z_INDEX } from "@/lib/shell-layering";
import { formatShellDisplayName, getShellStatusDotClassName, getShellStatusDotStyle } from "./TerminalSidebarItems";
import type { ShellSessionSummary } from "./terminal-session-state";

const POPOVER_GAP = 12;
const POPOVER_MARGIN = 12;
const POPOVER_WIDTH = 340;
const POPOVER_ESTIMATED_HEIGHT = 174;
const CLOSE_CONFIRMATION_MOTION_CSS = `
@keyframes terminal-close-popover-in-right {
  from {
    opacity: 0;
    transform: translate3d(-8px, 0, 0) scale(0.975);
  }
  to {
    opacity: 1;
    transform: translate3d(0, 0, 0) scale(1);
  }
}

@keyframes terminal-close-popover-in-left {
  from {
    opacity: 0;
    transform: translate3d(8px, 0, 0) scale(0.975);
  }
  to {
    opacity: 1;
    transform: translate3d(0, 0, 0) scale(1);
  }
}

@keyframes terminal-close-backdrop-in {
  from { background-color: rgba(3, 10, 3, 0); }
  to { background-color: rgba(3, 10, 3, 0.74); }
}

@keyframes terminal-close-sheet-in {
  from {
    opacity: 0;
    transform: translate3d(0, 18px, 0) scale(0.985);
  }
  to {
    opacity: 1;
    transform: translate3d(0, 0, 0) scale(1);
  }
}

@media (prefers-reduced-motion: reduce) {
  [data-terminal-close-motion] {
    animation: none !important;
    opacity: 1 !important;
    transform: none !important;
  }
}
`;

type PopoverPosition = {
  left: number;
  top: number;
  placement: "left" | "right";
};

function getPopoverPosition(
  anchorRect: Pick<DOMRect, "height" | "left" | "right" | "top">,
  surfaceSize: { width: number; height: number },
  viewportSize: { width: number; height: number },
): PopoverPosition {
  const fitsOnRight = anchorRect.right + POPOVER_GAP + surfaceSize.width
    <= viewportSize.width - POPOVER_MARGIN;
  const placement = fitsOnRight ? "right" : "left";
  const unclampedLeft = placement === "right"
    ? anchorRect.right + POPOVER_GAP
    : anchorRect.left - POPOVER_GAP - surfaceSize.width;
  const maxLeft = Math.max(POPOVER_MARGIN, viewportSize.width - POPOVER_MARGIN - surfaceSize.width);
  const maxTop = Math.max(POPOVER_MARGIN, viewportSize.height - POPOVER_MARGIN - surfaceSize.height);
  return {
    left: Math.min(maxLeft, Math.max(POPOVER_MARGIN, unclampedLeft)),
    top: Math.min(
      maxTop,
      Math.max(POPOVER_MARGIN, anchorRect.top + (anchorRect.height - surfaceSize.height) / 2),
    ),
    placement,
  };
}

function readPopoverPosition(anchorElement: HTMLElement, surfaceElement: HTMLElement | null): PopoverPosition {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const width = surfaceElement?.offsetWidth || Math.min(
    POPOVER_WIDTH,
    Math.max(0, viewportWidth - POPOVER_MARGIN * 2),
  );
  const height = surfaceElement?.offsetHeight || POPOVER_ESTIMATED_HEIGHT;
  return getPopoverPosition(
    anchorElement.getBoundingClientRect(),
    { width, height },
    { width: viewportWidth, height: viewportHeight },
  );
}

function formatMeta(shell: ShellSessionSummary): string {
  const placement = shell.placement === "background" ? "background" : "active";
  const unreadCount = typeof shell.latestSeq === "number" && typeof shell.lastSeenSeq === "number"
    ? Math.max(0, shell.latestSeq - shell.lastSeenSeq)
    : shell.unread ? 1 : 0;
  return unreadCount > 0 ? `${placement} · ${unreadCount} unread` : placement;
}

export function ShellCloseConfirmation({
  shell,
  anchorElement,
  mobile,
  deleting,
  onCancel,
  onConfirm,
}: {
  shell: ShellSessionSummary;
  anchorElement: HTMLElement;
  mobile: boolean;
  deleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const [desktopPosition, setDesktopPosition] = useState<PopoverPosition>(() => (
    typeof window === "undefined"
      ? { left: POPOVER_MARGIN, top: POPOVER_MARGIN, placement: "right" }
      : readPopoverPosition(anchorElement, null)
  ));
  const displayName = formatShellDisplayName(shell.name);
  const bodyCopy = mobile
    ? "Closing permanently deletes this session and its transcript. This can't be undone."
    : "Closing ends the session and permanently deletes it and its transcript. You won't be able to reopen or recover it — this can't be undone.";
  const cancelConfirmation = useEffectEvent(onCancel);

  useLayoutEffect(() => {
    if (mobile) return;
    const updatePosition = () => {
      const nextPosition = readPopoverPosition(anchorElement, sheetRef.current);
      setDesktopPosition((currentPosition) => (
        currentPosition.left === nextPosition.left
        && currentPosition.top === nextPosition.top
        && currentPosition.placement === nextPosition.placement
          ? currentPosition
          : nextPosition
      ));
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [anchorElement, mobile]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") cancelConfirmation();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (mobile) return;
    cancelButtonRef.current?.focus({ preventScroll: true });
  }, [mobile]);

  useEffect(() => {
    if (mobile) return;
    const onPointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && sheetRef.current?.contains(target)) return;
      cancelConfirmation();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [mobile]);

  const sheetStyle: CSSProperties = mobile
    ? {
        animationDuration: "220ms",
        animationFillMode: "both",
        animationName: "terminal-close-sheet-in",
        animationTimingFunction: "cubic-bezier(0.2, 0.78, 0.2, 1)",
        background: "#FFFDF7",
        borderTopLeftRadius: 26,
        borderTopRightRadius: 26,
        boxShadow: "0 -18px 50px rgba(0,0,0,0.44)",
        display: "flex",
        flexDirection: "column",
        gap: 18,
        maxWidth: 390,
        padding: "10px 22px 0",
        transformOrigin: "center bottom",
        willChange: "opacity, transform",
        width: "100%",
      }
    : {
        animationDuration: "180ms",
        animationFillMode: "both",
        animationName: desktopPosition.placement === "right"
          ? "terminal-close-popover-in-right"
          : "terminal-close-popover-in-left",
        animationTimingFunction: "cubic-bezier(0.2, 0.78, 0.2, 1)",
        background: "#FFFDF7",
        border: "1px solid #E4E2D2",
        borderRadius: 12,
        boxSizing: "border-box",
        boxShadow: "none",
        display: "flex",
        flexDirection: "column",
        gap: 14,
        maxWidth: "100%",
        padding: 16,
        transformOrigin: desktopPosition.placement === "right" ? "left center" : "right center",
        willChange: "opacity, transform",
        width: "100%",
      };

  const confirmationDialog = (
    <dialog
      open
      aria-modal={mobile}
      aria-labelledby={titleId}
      data-placement={mobile ? undefined : desktopPosition.placement}
      data-terminal-close-motion={mobile ? "mobile-backdrop" : undefined}
      tabIndex={-1}
      style={mobile
        ? {
            alignItems: "flex-end",
            animationDuration: "180ms",
            animationFillMode: "both",
            animationName: "terminal-close-backdrop-in",
            animationTimingFunction: "ease-out",
            background: "rgba(3, 10, 3, 0.74)",
            border: 0,
            bottom: 0,
            display: "flex",
            justifyContent: "center",
            left: 0,
            margin: 0,
            maxHeight: "none",
            maxWidth: "none",
            padding: 0,
            position: "absolute",
            right: 0,
            top: 0,
            width: "auto",
            zIndex: SHELL_Z_INDEX.popover,
          }
        : {
            background: "transparent",
            border: 0,
            left: desktopPosition.left,
            margin: 0,
            maxHeight: "calc(100vh - 24px)",
            maxWidth: "calc(100vw - 24px)",
            overflow: "visible",
            padding: 0,
            position: "fixed",
            right: "auto",
            top: desktopPosition.top,
            width: POPOVER_WIDTH,
            zIndex: SHELL_Z_INDEX.popover,
          }}
    >
      {mobile ? (
        <button
          type="button"
          aria-label="Cancel close session"
          onClick={onCancel}
          style={{
            background: "transparent",
            border: 0,
            bottom: 0,
            cursor: "default",
            left: 0,
            padding: 0,
            position: "absolute",
            right: 0,
            top: 0,
          }}
        />
      ) : null}
      <style>{CLOSE_CONFIRMATION_MOTION_CSS}</style>
      <div
        ref={sheetRef}
        data-terminal-close-motion={mobile ? "mobile-sheet" : "desktop"}
        data-testid="terminal-close-confirmation-sheet"
        style={{ ...sheetStyle, position: "relative", zIndex: 1 }}
      >
        {mobile ? (
          <div className="flex items-center justify-center" style={{ paddingBottom: 6 }}>
            <span style={{ background: "#D6D5C4", borderRadius: 999, height: 5, width: 42 }} />
          </div>
        ) : null}
        <div style={{ alignItems: "flex-start", display: "flex", gap: mobile ? 14 : 12 }}>
          <div
            className="flex shrink-0 items-center justify-center"
            style={{
              background: "#F0EFE5",
              border: "1px solid #DCDAC9",
              borderRadius: mobile ? 13 : 10,
              color: "#77786E",
              height: mobile ? 46 : 36,
              width: mobile ? 46 : 36,
            }}
          >
            <Trash2Icon aria-hidden="true" size={mobile ? 21 : 16} strokeWidth={2} />
          </div>
          <div style={{ display: "flex", flex: "1 1 0%", flexDirection: "column", gap: mobile ? 6 : 4, minWidth: 0, paddingTop: mobile ? 2 : 0 }}>
            <div
              id={titleId}
              style={{
                color: "#2A2E22",
                fontFamily: "Inter, system-ui, sans-serif",
                fontSize: mobile ? 19 : 14,
                fontWeight: 700,
                lineHeight: mobile ? "24px" : "18px",
              }}
            >
              Close this session?
            </div>
            <div
              style={{
                color: "#858578",
                fontFamily: "Inter, system-ui, sans-serif",
                fontSize: mobile ? 14 : 11,
                lineHeight: mobile ? "20px" : "15px",
              }}
            >
              {bodyCopy}
            </div>
          </div>
        </div>
        <div
          style={{
            alignItems: "center",
            background: "#F4F3E9",
            border: "1px solid #E4E2D2",
            borderRadius: mobile ? 12 : 10,
            display: "flex",
            flexShrink: 0,
            gap: mobile ? 10 : 8,
            height: mobile ? 48 : 30,
            padding: mobile ? "0 14px" : "0 10px",
          }}
        >
          <span
            className={getShellStatusDotClassName(shell)}
            aria-hidden="true"
            style={{
              ...getShellStatusDotStyle(shell),
              borderRadius: 999,
              flexShrink: 0,
              height: mobile ? 8 : 6,
              width: mobile ? 8 : 6,
            }}
          />
          <span
            className="truncate"
            style={{
              color: "#31362D",
              flex: "1 1 0%",
              fontFamily: "var(--font-mono, ui-monospace, monospace)",
              fontSize: mobile ? 15 : 11,
              fontWeight: 700,
              lineHeight: mobile ? "18px" : "14px",
              minWidth: 0,
            }}
          >
            {displayName}
          </span>
          <span
            style={{
              color: "#A09F92",
              flexShrink: 0,
              fontFamily: "Inter, system-ui, sans-serif",
              fontSize: mobile ? 12 : 10,
              fontWeight: 500,
              lineHeight: mobile ? "16px" : "12px",
            }}
          >
            {formatMeta(shell)}
          </span>
        </div>
        {mobile ? (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <button
                type="button"
                aria-label="Delete"
                disabled={deleting}
                onClick={onConfirm}
                className="flex items-center justify-center"
                style={{
                  background: "#2A2E22",
                  border: 0,
                  borderRadius: 14,
                  color: "#F8F7EF",
                  cursor: deleting ? "not-allowed" : "pointer",
                  fontFamily: "Inter, system-ui, sans-serif",
                  fontSize: 16,
                  fontWeight: 600,
                  gap: 8,
                  height: 52,
                  opacity: deleting ? 0.68 : 1,
                }}
              >
                <Trash2Icon aria-hidden="true" size={17} strokeWidth={2} />
                Delete
              </button>
              <button
                type="button"
                aria-label="Cancel"
                onClick={onCancel}
                className="flex items-center justify-center"
                style={{
                  background: "#F0EFE5",
                  border: "1px solid #DCDAC9",
                  borderRadius: 14,
                  color: "#3E4339",
                  cursor: "pointer",
                  fontFamily: "Inter, system-ui, sans-serif",
                  fontSize: 16,
                  fontWeight: 600,
                  height: 52,
                }}
              >
                Cancel
              </button>
            </div>
            <div className="flex items-center justify-center" style={{ paddingBottom: 9, paddingTop: 8 }}>
              <span style={{ background: "#1F221B", borderRadius: 999, height: 5, width: 140 }} />
            </div>
          </>
        ) : (
          <div style={{ alignItems: "center", display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button
              ref={cancelButtonRef}
              type="button"
              aria-label="Cancel"
              onClick={onCancel}
              className="flex items-center justify-center"
              style={{
                background: "#F0EFE5",
                border: "1px solid #DCDAC9",
                borderRadius: 7,
                color: "#3E4339",
                cursor: "pointer",
                fontFamily: "Inter, system-ui, sans-serif",
                fontSize: 12,
                fontWeight: 600,
                height: 30,
                padding: "0 14px",
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              aria-label="Delete"
              disabled={deleting}
              onClick={onConfirm}
              className="flex items-center justify-center"
              style={{
                background: "#2A2E22",
                border: 0,
                borderRadius: 7,
                color: "#F8F7EF",
                cursor: deleting ? "not-allowed" : "pointer",
                fontFamily: "Inter, system-ui, sans-serif",
                fontSize: 12,
                fontWeight: 600,
                gap: 6,
                height: 30,
                opacity: deleting ? 0.68 : 1,
                padding: "0 14px",
              }}
            >
              <Trash2Icon aria-hidden="true" size={13} strokeWidth={2} />
              Delete
            </button>
          </div>
        )}
      </div>
    </dialog>
  );

  return !mobile && typeof document !== "undefined"
    ? createPortal(confirmationDialog, document.body)
    : confirmationDialog;
}
