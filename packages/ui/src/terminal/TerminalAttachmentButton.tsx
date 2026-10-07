import React, { useRef } from "react";
import { TerminalControlIcon } from "./TerminalControlIcon.js";

export interface TerminalAttachmentAction {
  enabled: boolean;
  onSelectFiles(files: File[]): void;
}

export function TerminalAttachmentButton({ action, target }: {
  action: TerminalAttachmentAction;
  target: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const selectionTarget = useRef<string | null>(null);
  return <>
    <button type="button" className="matrix-terminal-icon-button" aria-label="Attach files" title="Attach files"
      disabled={!action.enabled} onClick={() => {
        selectionTarget.current = target;
        input.current?.click();
      }}>
      <TerminalControlIcon name="attachment" />
    </button>
    <input ref={input} type="file" multiple hidden aria-label="Choose files to attach" onChange={(event) => {
      const files = Array.from(event.currentTarget.files ?? []);
      event.currentTarget.value = "";
      if (action.enabled && selectionTarget.current === target && files.length > 0) action.onSelectFiles(files);
      selectionTarget.current = null;
    }} />
  </>;
}
