/** Pure helpers of the title bar and status bar. */

import type { SessionState } from "../session/index";

export type SaveTone = "saved" | "unsaved" | "saving" | "conflict" | "error" | "draft";

export interface SaveIndicator {
  tone: SaveTone;
  label: string;
}

export function describeSaveState(state: SessionState): SaveIndicator {
  if (state.conflict !== null) return { tone: "conflict", label: "Changed elsewhere" };
  if (state.saveStatus === "saving") return { tone: "saving", label: "Saving…" };
  if (state.saveStatus === "error") return { tone: "error", label: "Not saved" };
  if (state.source === "local") {
    // A document from the computer is saved by downloading it again.
    if (state.dirty) return { tone: "unsaved", label: "Unsaved changes" };
    return state.saveStatus === "saved" ? { tone: "saved", label: "Downloaded" } : { tone: "saved", label: "Not changed" };
  }
  if (state.path === null) return { tone: "draft", label: "Not saved yet" };
  if (state.dirty) return { tone: "unsaved", label: "Unsaved changes" };
  return { tone: "saved", label: "Saved" };
}

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu;

export function countWords(text: string): number {
  let count = 0;
  for (const _ of text.matchAll(WORD)) count++;
  return count;
}

export function plural(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;
}
