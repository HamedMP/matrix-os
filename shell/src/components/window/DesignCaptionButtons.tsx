"use client";

import type { CSSProperties } from "react";
import { Minus, Square, X } from "lucide-react";
import type { TitleBarVariant } from "./title-bar-variant";

/**
 * Right-aligned window caption buttons (minimize / maximize / close) for the
 * Windows-style design systems. XP renders raised beveled squares with white
 * glyphs (close in the red-orange Luna gradient); Win11 renders flat Fluent
 * glyph buttons with a subtle hover fill and a red close hover.
 */

export interface CaptionButtonsProps {
  onClose: () => void;
  /** When omitted the minimize button is not rendered (e.g. modal surfaces). */
  onMinimize?: () => void;
  /** When omitted the maximize button is not rendered (e.g. modal surfaces). */
  onMaximize?: () => void;
}

const xpButtonBase: CSSProperties = {
  border: "1px solid rgba(0, 0, 0, 0.4)",
  borderRadius: 3,
  boxShadow:
    "inset 1px 1px 0 var(--xp-bevel-light), inset -1px -1px 0 var(--xp-bevel-dark)",
};

const xpBlueButton: CSSProperties = {
  ...xpButtonBase,
  background: "linear-gradient(to bottom, var(--xp-blue-light), var(--xp-blue-dark))",
};

const xpCloseButton: CSSProperties = {
  ...xpButtonBase,
  background: "linear-gradient(to bottom, #e67c52, #d6522c)",
};

export function WinXpCaptionButtons({ onClose, onMinimize, onMaximize }: CaptionButtonsProps) {
  const buttonClass =
    "size-[21px] flex items-center justify-center text-white hover:brightness-110 active:brightness-95";
  return (
    <div
      data-caption-buttons="winxp"
      className="flex items-center gap-0.5 shrink-0"
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {onMinimize && (
        <button
          type="button"
          className={buttonClass}
          style={xpBlueButton}
          onClick={(e) => { e.stopPropagation(); onMinimize(); }}
          aria-label="Minimize"
        >
          <Minus className="size-3" strokeWidth={3} />
        </button>
      )}
      {onMaximize && (
        <button
          type="button"
          className={buttonClass}
          style={xpBlueButton}
          onClick={(e) => { e.stopPropagation(); onMaximize(); }}
          aria-label="Maximize"
        >
          <Square className="size-2.5" strokeWidth={3} />
        </button>
      )}
      <button
        type="button"
        className={buttonClass}
        style={xpCloseButton}
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        aria-label="Close"
      >
        <X className="size-3" strokeWidth={3} />
      </button>
    </div>
  );
}

export function Win11CaptionButtons({ onClose, onMinimize, onMaximize }: CaptionButtonsProps) {
  const buttonClass =
    "h-6 w-8 flex items-center justify-center rounded text-foreground/70 transition-colors hover:bg-[var(--win11-hover)]";
  return (
    <div
      data-caption-buttons="win11"
      className="flex items-center shrink-0"
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {onMinimize && (
        <button
          type="button"
          className={buttonClass}
          onClick={(e) => { e.stopPropagation(); onMinimize(); }}
          aria-label="Minimize"
        >
          <Minus className="size-3.5" strokeWidth={1.5} />
        </button>
      )}
      {onMaximize && (
        <button
          type="button"
          className={buttonClass}
          onClick={(e) => { e.stopPropagation(); onMaximize(); }}
          aria-label="Maximize"
        >
          <Square className="size-3" strokeWidth={1.5} />
        </button>
      )}
      <button
        type="button"
        className={`${buttonClass} hover:bg-[#c42b1c] hover:text-white`}
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        aria-label="Close"
      >
        <X className="size-3.5" strokeWidth={1.5} />
      </button>
    </div>
  );
}

/** Dispatches to the caption-button set matching the active design system. */
export function DesignCaptionButtons({
  variant,
  ...props
}: CaptionButtonsProps & { variant: TitleBarVariant }) {
  return variant === "winxp"
    ? <WinXpCaptionButtons {...props} />
    : <Win11CaptionButtons {...props} />;
}
