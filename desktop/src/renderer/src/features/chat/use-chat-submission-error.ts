import { useCallback, useLayoutEffect, useRef, useState } from "react";

/** One attempt's feedback belongs to its unchanged composer, never a later draft. */
export function useChatSubmissionError(scope: string, revision: number, attachmentIds: readonly string[]) {
  const key = JSON.stringify([scope, revision, attachmentIds]);
  const currentKey = useRef(key);
  const [saved, setSaved] = useState<{ key: string; message: string } | null>(null);
  useLayoutEffect(() => { currentKey.current = key; }, [key]);
  const setError = useCallback((message: string | null) => {
    if (currentKey.current !== key) return;
    setSaved(message === null ? null : { key, message });
  }, [key]);
  return [saved?.key === key ? saved.message : null, setError] as const;
}
