import { useEffect, useRef, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "./cn.js";

export interface DialogProps extends HTMLAttributes<HTMLDivElement> {
  open: boolean;
  onClose: () => void;
  children?: ReactNode;
}

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(0, 0, 0, 0.4)",
  backdropFilter: "blur(4px)",
  WebkitBackdropFilter: "blur(4px)",
  zIndex: 50,
  animation: "matrix-dialog-overlay-in 0.15s ease-out",
};

const contentStyle: React.CSSProperties = {
  background: "var(--matrix-card)",
  color: "var(--matrix-card-fg)",
  borderRadius: "var(--matrix-radius-xl)",
  padding: "24px",
  maxWidth: "480px",
  width: "90%",
  maxHeight: "85vh",
  overflowY: "auto",
  boxShadow: "0 20px 60px rgba(0, 0, 0, 0.15)",
  animation: "matrix-dialog-content-in 0.15s ease-out",
};

export function Dialog({ open, onClose, className, style, children, ...rest }: DialogProps) {
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (open && contentRef.current) {
      contentRef.current.focus();
    }
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="matrix-dialog-overlay"
      style={overlayStyle}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
    >
      <div
        ref={contentRef}
        className={cn("matrix-dialog", className)}
        style={{ ...contentStyle, ...style }}
        tabIndex={-1}
        {...rest}
      >
        {children}
      </div>
    </div>
  );
}

export interface DialogTitleProps extends HTMLAttributes<HTMLHeadingElement> {
  children?: ReactNode;
}

export function DialogTitle({ className, style, children, ...rest }: DialogTitleProps) {
  return (
    <h2
      className={cn("matrix-dialog-title", className)}
      style={{
        margin: "0 0 16px",
        fontSize: "1.25rem",
        fontWeight: 600,
        color: "var(--matrix-fg)",
        ...style,
      }}
      {...rest}
    >
      {children}
    </h2>
  );
}

export interface DialogFooterProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode;
}

export function DialogFooter({ className, style, children, ...rest }: DialogFooterProps) {
  return (
    <div
      className={cn("matrix-dialog-footer", className)}
      style={{
        display: "flex",
        justifyContent: "flex-end",
        gap: "8px",
        marginTop: "24px",
        ...style,
      }}
      {...rest}
    >
      {children}
    </div>
  );
}
