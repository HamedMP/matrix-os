import { useEffect, useRef, useState } from "react";

const COPIED_MS = 1600;

/** Clipboard copy with a short "Copied" confirmation per key. */
export function useCopy() {
  const [copied, setCopied] = useState<{ key: string; failed: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const show = (key: string, failed: boolean) => {
    setCopied({ key, failed });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(null), COPIED_MS);
  };
  return {
    copy(key: string, text: string) {
      const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
      if (!clipboard) { show(key, true); return; }
      clipboard.writeText(text).then(() => show(key, false), (error: unknown) => {
        console.warn("[share] copy failed", error instanceof Error ? error.name : "UnknownError");
        show(key, true);
      });
    },
    label(key: string, idle: string) {
      if (copied?.key !== key) return idle;
      return copied.failed ? "Couldn’t copy" : "Copied";
    },
  };
}
