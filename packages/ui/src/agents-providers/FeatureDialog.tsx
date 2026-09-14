import { useEffect, useRef, type ReactNode } from "react";
import { useGettingStartedBlocker } from "../getting-started-visibility.js";

export function FeatureDialog({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  useGettingStartedBlocker(true);
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>("button, input, select")?.focus();
  }, []);

  return (
    <div
      className="matrix-ap-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="matrix-ap-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      >
        <div className="matrix-ap-dialog-head">
          <h3>{title}</h3>
          <button type="button" className="matrix-ap-icon-button" aria-label="Close dialog" onClick={onClose}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
