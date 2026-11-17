import * as Clipboard from "expo-clipboard";

import { successHaptic } from "@/lib/haptics";
import { showToast } from "@/lib/toast";

export interface CopyFeedback {
  /** The toast for a copy that worked. Without one, the copy is only felt, for a control that shows it itself. */
  copied?: string;
  /** The toast for a copy that did not work. */
  failed: string;
}

/**
 * Puts `value` on the clipboard and tells the person how it went. `current`
 * says whether the result still belongs on screen. Resolves to whether it copied.
 */
export async function copyToClipboard(
  value: string,
  feedback: CopyFeedback,
  current: () => boolean = () => true,
): Promise<boolean> {
  try {
    const copied = await Clipboard.setStringAsync(value);
    if (copied === false) throw new Error("Clipboard unavailable");
  } catch (error: unknown) {
    // The platform's own words can name internals; the person gets ours.
    console.warn("[chat] Clipboard copy failed", error instanceof Error ? error.name : "UnknownError");
    if (current()) showToast(feedback.failed, "error");
    return false;
  }
  if (current()) {
    if (feedback.copied) showToast(feedback.copied);
    else successHaptic();
  }
  return true;
}
