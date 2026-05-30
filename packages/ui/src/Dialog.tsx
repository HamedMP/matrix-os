import { useEffect, useEffectEvent, useRef, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "./cn.js";

export interface DialogProps extends HTMLAttributes<HTMLDivElement> {
  open: boolean;
  onClose: () => void;
  children?: ReactNode;
}

const overlayStyle: React.CSSProperties = {
  padding: 0,
  border: "none",
  background: "transparent",
  maxWidth: "100vw",
  maxHeight: "100vh",
  overflow: "visible",
};

const contentStyle: React.CSSProperties = {
  background: "var(--matrix-card)",
  color: "var(--matrix-card-fg)",
  borderRadius: "var(--matrix-radius-xl)",
  padding: "24px",
  maxWidth: "480px",
  width: "90vw",
  maxHeight: "85vh",
  overflowY: "auto",
  boxShadow: "0 20px 60px rgba(0, 0, 0, 0.15)",
};

export function Dialog({ open, onClose, className, style, children, ...rest }: DialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  // Read the latest onClose from the listeners without re-subscribing them.
  const onDismiss = useEffectEvent(() => {
    onClose();
  });

  // Drive the native <dialog> from the controlled `open` prop. showModal()
  // gives us focus trapping, an inert background, and Escape handling for free.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open) {
      dialog.close();
    }
  }, [open]);

  // Map native dismissal to onClose using DOM listeners (rather than JSX
  // handlers) so the non-interactive <dialog> element carries no a11y-flagged
  // interaction props.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const handleCancel = (event: Event) => {
      // Keep visibility controlled by the `open` prop instead of the native
      // Escape-driven close.
      event.preventDefault();
      onDismiss();
    };
    const handleClick = (event: MouseEvent) => {
      // A click whose target is the <dialog> itself originates from the backdrop.
      if (event.target === dialog) onDismiss();
    };
    dialog.addEventListener("cancel", handleCancel);
    dialog.addEventListener("click", handleClick);
    return () => {
      dialog.removeEventListener("cancel", handleCancel);
      dialog.removeEventListener("click", handleClick);
    };
  }, []);

  return (
    <dialog ref={dialogRef} className="matrix-dialog-overlay" style={overlayStyle}>
      <div className={cn("matrix-dialog", className)} style={{ ...contentStyle, ...style }} {...rest}>
        {children}
      </div>
    </dialog>
  );
}
