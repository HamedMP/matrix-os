import { useEffect, useRef, useState, type ReactNode } from "react";
import { Copy01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "../Button.js";
import { Dialog } from "../Dialog.js";
import { DialogFooter } from "../DialogFooter.js";
import { DialogTitle } from "../DialogTitle.js";
import { PRIVATE_NETWORK_ERRORS, logRequestFailure, mutedText } from "./presentation.js";

const COPIED_MS = 2_000;

/** Copies text; the label swap keeps its width so feedback never shifts layout. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [result, setResult] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setResult("copied");
    } catch (error: unknown) {
      logRequestFailure("copy", error);
      setResult("failed");
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setResult("idle"), COPIED_MS);
  };
  return (
    <Button variant="secondary" size="sm" aria-label={label} onClick={() => void copy()} style={{ minWidth: "5.5rem" }}>
      <HugeiconsIcon icon={Copy01Icon} size={14} strokeWidth={1.6} aria-hidden />
      <span aria-live="polite">{result === "copied" ? "Copied" : result === "failed" ? "Failed" : "Copy"}</span>
      {result === "failed" && <span className="sr-only">{PRIVATE_NETWORK_ERRORS.copy}</span>}
    </Button>
  );
}

/** Reserved-height feedback line: messages appear without pushing content. */
export function FeedbackLine({ message }: { message: string | null }) {
  return (
    <p role="alert" style={{ ...mutedText, minHeight: "1.25rem", color: "var(--matrix-destructive)" }}>
      {message ?? ""}
    </p>
  );
}

export function ConfirmDialog({
  open,
  title,
  confirmLabel,
  busy,
  onConfirm,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  confirmLabel: string;
  busy: boolean;
  onConfirm(): void;
  onClose(): void;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <Dialog open onClose={busy ? () => undefined : onClose} aria-label={title}>
      <DialogTitle>{title}</DialogTitle>
      <div style={{ display: "flex", flexDirection: "column", gap: "8px", fontSize: "0.875rem" }}>{children}</div>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="destructive" onClick={onConfirm} disabled={busy}>
          {confirmLabel}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
