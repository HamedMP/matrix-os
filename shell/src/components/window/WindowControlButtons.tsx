"use client";

import { ArrowExpand01, Minus, X } from "@/lib/hugeicons";
import type { MouseEvent } from "react";

export type WindowControlKind = "close" | "minimize" | "maximize";

const CONTROL_STYLE = {
  background: "var(--surface-primary, #FFFEFC)",
  border: "0.8px solid var(--border-default, #F3F2F2)",
};

function WindowControlGlyph({ kind }: { kind: WindowControlKind }) {
  if (kind === "close") return <X size={11.2} strokeWidth={1.7} />;
  if (kind === "minimize") return <Minus size={11.2} strokeWidth={1.7} />;
  return <ArrowExpand01 size={11.2} strokeWidth={1.7} />;
}

function WindowControlButton({
  kind,
  label,
  onClick,
}: {
  kind: WindowControlKind;
  label: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      data-window-control={kind}
      className="no-drag flex size-4 items-center justify-center rounded-[4.8px] text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
      style={CONTROL_STYLE}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event: MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        onClick?.();
      }}
      disabled={!onClick}
    >
      <WindowControlGlyph kind={kind} />
    </button>
  );
}

export function WindowControlButtons({
  title,
  className,
  onClose,
  onMinimize,
  onMaximize,
  maximizeLabel = "Maximize",
}: {
  title?: string;
  className?: string;
  onClose: () => void;
  onMinimize: () => void;
  onMaximize?: () => void;
  maximizeLabel?: string;
}) {
  const label = (action: string) => title ? `${action} ${title}` : action;
  return (
    <div
      data-window-control-group
      className={`no-drag flex shrink-0 items-center gap-0.5 ${className ?? ""}`}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <WindowControlButton kind="close" label={label("Close")} onClick={onClose} />
      <WindowControlButton kind="minimize" label={label("Minimize")} onClick={onMinimize} />
      <WindowControlButton kind="maximize" label={label(maximizeLabel)} onClick={onMaximize} />
    </div>
  );
}
