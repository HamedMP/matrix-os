import { cloneElement, type KeyboardEvent, type ReactElement, type ReactNode } from "react";
import { Minus, X } from "@renderer/lib/hugeicons";

export type DesktopTabProps = {
  mode: "full" | "iconOnly";
  label: string;
  icon: ReactElement<{ size?: number }>;
  selected?: boolean;
  canClose?: boolean;
  onClick: () => void;
  onDoubleClick?: () => void;
  onMinimize?: () => void;
  onClose?: () => void;
  children?: ReactNode;
  isLast?: boolean;
};

const tabBorderStyle = (isLast: boolean) => ({
  borderLeft: "1px solid var(--border-default, #F3F2F2)",
  ...(isLast ? { borderRight: "1px solid var(--border-default, #F3F2F2)" } : {}),
});

function activateFromKeyboard(event: KeyboardEvent<HTMLElement>, onClick: () => void) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    onClick();
  }
}

export default function DesktopTab({
  mode,
  label,
  icon,
  selected = false,
  canClose = false,
  onClick,
  onDoubleClick,
  onMinimize,
  onClose,
  children,
  isLast = false,
}: DesktopTabProps) {
  const iconElement = cloneElement(icon, { size: 14 });
  const colors = {
    background: selected ? "var(--bg-app)" : "transparent",
    color: selected ? "var(--text-primary)" : "var(--text-secondary)",
  };

  if (mode === "iconOnly") {
    return (
      <button
        type="button"
        role="tab"
        aria-label={label}
        aria-selected={selected}
        title={label}
        data-desktop-tab
        className="no-drag flex h-full shrink-0 items-center justify-center border-l p-3 outline-none transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        style={{ ...tabBorderStyle(isLast), ...colors, height: "var(--titlebar-height)" }}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
      >
        {iconElement}
      </button>
    );
  }

  return (
    <div
      data-desktop-tab
      className="titlebar-drag group flex h-full min-w-[132px] max-w-[220px] shrink-0 items-center gap-2 border-l px-3 text-xs outline-none transition-colors hover:bg-[var(--bg-hover)]"
      style={{ ...tabBorderStyle(isLast), ...colors, height: "var(--titlebar-height)" }}
    >
      <button
        type="button"
        role="tab"
        aria-label={label}
        aria-selected={selected}
        className="no-drag flex min-w-0 flex-1 items-center gap-2 text-left outline-none"
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        onKeyDown={(event) => activateFromKeyboard(event, onClick)}
      >
        {iconElement}
        <span className="min-w-0 flex-1 truncate">{children ?? label}</span>
      </button>
      {onMinimize ? (
        <button
          type="button"
          aria-label={`Minimize ${label} tab`}
          title={`Minimize ${label}`}
          className="no-drag flex size-5 shrink-0 items-center justify-center rounded opacity-60 hover:bg-[var(--bg-hover)] hover:opacity-100"
          onClick={(event) => {
            event.stopPropagation();
            onMinimize();
          }}
        >
          <Minus size={12} aria-hidden="true" />
        </button>
      ) : null}
      {canClose && onClose ? (
        <button
          type="button"
          aria-label={`Close ${label}`}
          title={`Close ${label}`}
          className="no-drag flex size-5 shrink-0 items-center justify-center rounded opacity-60 hover:bg-[var(--bg-hover)] hover:opacity-100"
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
        >
          <X size={12} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
