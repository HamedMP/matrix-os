import type { KeyboardEvent, RefObject } from "react";

export function handleChatInputKey(event: KeyboardEvent<HTMLTextAreaElement>, options: {
  query: string | null; mentionListRef: RefObject<HTMLDivElement | null>; onDismiss(): void; onSubmit(): void;
}) {
  if (event.key === "ArrowDown" && options.query !== null) {
    const first = options.mentionListRef.current?.querySelector<HTMLButtonElement>('button[role="option"]:not(:disabled)');
    if (first) { event.preventDefault(); first.focus(); return; }
  }
  if (event.key === "Escape" && options.query !== null) { options.onDismiss(); return; }
  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
    event.preventDefault(); options.onSubmit();
  }
}
