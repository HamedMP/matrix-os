"use client";

import type { MouseEvent } from "react";

export type WindowControlKind = "close" | "minimize" | "maximize";

function WindowControlGlyph({ kind }: { kind: WindowControlKind }) {
  if (kind === "close") {
    return (
      <span data-window-control-glyph className="relative block size-2 opacity-0 transition-opacity group-hover/window-controls:opacity-100" aria-hidden="true">
        <span className="absolute left-1/2 top-1/2 h-px w-2 -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-full bg-black/60" />
        <span className="absolute left-1/2 top-1/2 h-px w-2 -translate-x-1/2 -translate-y-1/2 -rotate-45 rounded-full bg-black/60" />
      </span>
    );
  }

  if (kind === "minimize") {
    return (
      <span
        data-window-control-glyph
        className="block h-px w-2 rounded-full bg-black/60 opacity-0 transition-opacity group-hover/window-controls:opacity-100"
        aria-hidden="true"
      />
    );
  }

  return (
    <span
      data-window-control-glyph
      className="block size-1.5 rounded-[1px] border border-black/60 opacity-0 transition-opacity group-hover/window-controls:opacity-100"
      aria-hidden="true"
    />
  );
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
  const lightColor = kind === "close"
    ? "bg-[#ff5f57]"
    : kind === "minimize"
      ? "bg-[#febc2e]"
      : "bg-[#28c840]";
  return (
    <button
      type="button"
      aria-label={label}
      data-window-control={kind}
      className="flex size-5 items-center justify-center rounded-full transition-[filter,transform] hover:brightness-95 active:scale-90 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event: MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        onClick?.();
      }}
      disabled={!onClick}
    >
      <span
        data-window-control-light
        className={`flex size-3 items-center justify-center rounded-full shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.16)] ${lightColor}`}
      >
        <WindowControlGlyph kind={kind} />
      </span>
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
      className={`group/window-controls flex w-16 shrink-0 items-center gap-0.5 ${className ?? ""}`}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <WindowControlButton kind="close" label={label("Close")} onClick={onClose} />
      <WindowControlButton kind="minimize" label={label("Minimize")} onClick={onMinimize} />
      <WindowControlButton kind="maximize" label={label(maximizeLabel)} onClick={onMaximize} />
    </div>
  );
}
