import type { DragEvent } from "react";
import { beginMatrixFileDrag, captureAttachmentConnection, endMatrixFileDrag } from "../../chat/attachments/matrix-file-attachment";
import { hasRegularDroppedFiles, regularDroppedFiles } from "../browser-views";

/**
 * Drag behaviour shared by cards and rows: files drag into Chat as Matrix
 * attachments (the existing matrix-file-drag path) and folders accept dropped
 * local files as an upload destination.
 */
export function entryDragProps<T extends HTMLElement>({ attachmentPath, onDropFiles }: { attachmentPath?: string; onDropFiles?: (files: File[]) => void }) {
  const connection = attachmentPath ? captureAttachmentConnection() : null;
  return {
    ...(attachmentPath && connection !== null ? {
      draggable: true,
      onDragStart: (event: DragEvent<T>) => beginMatrixFileDrag(event.dataTransfer, { kind: "home", path: attachmentPath }, connection),
      onDragEnd: endMatrixFileDrag,
    } : {}),
    ...(onDropFiles ? {
      onDragOver: (event: DragEvent<T>) => {
        if (hasRegularDroppedFiles(event.dataTransfer)) event.preventDefault();
      },
      onDrop: (event: DragEvent<T>) => {
        if (!hasRegularDroppedFiles(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        onDropFiles(regularDroppedFiles(event.dataTransfer));
      },
    } : {}),
  };
}
