import { useId, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { cx, useFocusTrap } from "./internal";

export interface DialogProps {
  open: boolean;
  /** Called for Escape, backdrop click and the close button. */
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Action row, usually buttons. */
  footer?: ReactNode;
  /** Element to focus when the dialog opens; defaults to the first focusable element. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  size?: "sm" | "md" | "lg";
  /** "alertdialog" for confirmations that interrupt the owner. */
  role?: "dialog" | "alertdialog";
  /** Close when the backdrop is clicked (default true). */
  dismissOnBackdrop?: boolean;
  /** Show the corner close button (default true). */
  showClose?: boolean;
  className?: string;
}

/**
 * Modal dialog rendered in a portal. Focus moves inside on open, Tab is trapped,
 * Escape closes, and focus returns to the element that opened it.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  initialFocusRef,
  size = "md",
  role = "dialog",
  dismissOnBackdrop = true,
  showClose = true,
  className,
}: DialogProps) {
  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <DialogSurface
      onClose={onClose}
      title={title}
      description={description}
      footer={footer}
      initialFocusRef={initialFocusRef}
      size={size}
      role={role}
      dismissOnBackdrop={dismissOnBackdrop}
      showClose={showClose}
      className={className}
    >
      {children}
    </DialogSurface>,
    document.body,
  );
}

type SurfaceProps = Omit<DialogProps, "open"> & Required<Pick<DialogProps, "size" | "role" | "dismissOnBackdrop" | "showClose">>;

function DialogSurface({ onClose, title, description, children, footer, initialFocusRef, size, role, dismissOnBackdrop, showClose, className }: SurfaceProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const downOnBackdrop = useRef(false);
  const titleId = useId();
  const descriptionId = useId();
  useFocusTrap(panelRef, true, { onEscape: onClose, initialFocusRef });

  return (
    // Pointer light dismiss only; the keyboard closes with Escape through the focus trap.
    <div
      role="presentation"
      className="oui-backdrop"
      data-testid="oui-dialog-backdrop"
      onMouseDown={(event) => {
        downOnBackdrop.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (dismissOnBackdrop && downOnBackdrop.current && event.target === event.currentTarget) onClose();
        downOnBackdrop.current = false;
      }}
    >
      <div
        ref={panelRef}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={cx("oui-dialog", `oui-dialog--${size}`, className)}
      >
        <header className="oui-dialog__header">
          <h2 id={titleId} className="oui-dialog__title">{title}</h2>
          {showClose && (
            <button type="button" className="oui-icon-button" aria-label="Close" onClick={onClose}>
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3.5 3.5l9 9m0-9l-9 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
            </button>
          )}
        </header>
        {description && <p id={descriptionId} className="oui-dialog__description">{description}</p>}
        {children !== undefined && <div className="oui-dialog__body">{children}</div>}
        {footer && <footer className="oui-dialog__footer">{footer}</footer>}
      </div>
    </div>
  );
}
