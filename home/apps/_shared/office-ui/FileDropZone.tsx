import { useEffect, useRef, useState } from "react";
import { cx, useLatest } from "./internal";
import { LocalFileError, MAX_LOCAL_FILE_BYTES, describeAccept, readDroppedFile, type LocalFile } from "./local-files";

/** Hide the overlay when no drag event arrived for this long (a drag that left the iframe silently). */
const DRAG_IDLE_MS = 1500;

export interface FileDropZoneProps {
  /** Extensions (".docx") and MIME types, as for pickLocalFile. */
  accept: readonly string[];
  onFile: (file: LocalFile) => void;
  onReject: (error: LocalFileError) => void;
  /** Size limit in bytes (default 10 MiB). */
  maxBytes?: number;
  /** Overlay headline (default "Drop a file to open it"). */
  label?: string;
  /** Overlay detail line (default lists the accepted types and the size limit). */
  hint?: string;
  disabled?: boolean;
  className?: string;
}

function carriesFiles(event: DragEvent): boolean {
  const types = event.dataTransfer?.types;
  if (!types) return false;
  return Array.from(types as ArrayLike<string>).includes("Files");
}

/**
 * Window-wide drop target for opening local files. It reacts only to drags that
 * carry files from outside the page, so text, cell and image drags inside the
 * document behave exactly as before. A drop another handler already took
 * (defaultPrevented) is left alone.
 */
export function FileDropZone({ accept, onFile, onReject, maxBytes = MAX_LOCAL_FILE_BYTES, label = "Drop a file to open it", hint, disabled, className }: FileDropZoneProps) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useLatest({ accept, onFile, onReject, maxBytes });

  useEffect(() => {
    if (disabled) return undefined;
    const clearIdle = () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
      idleTimer.current = null;
    };
    const hide = () => {
      clearIdle();
      depth.current = 0;
      setDragging(false);
    };
    const touch = () => {
      clearIdle();
      idleTimer.current = setTimeout(hide, DRAG_IDLE_MS);
    };
    const onEnter = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth.current += 1;
      setDragging(true);
      touch();
    };
    const onOver = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      setDragging(true);
      touch();
    };
    const onLeave = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) hide();
    };
    const onDrop = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      hide();
      if (event.defaultPrevented) return;
      event.preventDefault();
      const { accept: types, onFile: deliver, onReject: refuse, maxBytes: limit } = latest.current;
      readDroppedFile(event.dataTransfer, types, { maxBytes: limit }).then(deliver, (error: unknown) => {
        if (error instanceof LocalFileError) {
          refuse(error);
          return;
        }
        console.error("[office-ui] drop failed", error instanceof Error ? error.name : typeof error);
        refuse(new LocalFileError("read-failed", "The file could not be read. Try again."));
      });
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    window.addEventListener("dragend", hide);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("dragend", hide);
      hide();
    };
  }, [disabled, latest]);

  if (!dragging || disabled) return null;
  return (
    <div className={cx("oui-dropzone", className)} role="status" aria-live="polite">
      <div className="oui-dropzone__card">
        <svg viewBox="0 0 24 24" width="32" height="32" aria-hidden="true">
          <path d="M12 16V4m0 0l-4 4m4-4l4 4M5 14v4a2 2 0 002 2h10a2 2 0 002-2v-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <p className="oui-dropzone__label">{label}</p>
        <p className="oui-dropzone__hint">{hint ?? describeAccept(accept, maxBytes)}</p>
      </div>
    </div>
  );
}
