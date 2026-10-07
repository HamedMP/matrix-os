"use client";
import { useEffect, useRef, useState } from "react";
import type { AoedePanelProps } from "./AoedePanel.js";
/** Keeps edits made during admission and preserves failed drafts for explicit retry. */
export function useAoedeTextComposer(props: Pick<AoedePanelProps, "canSendText" | "pendingText" | "commands">) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [textError, setTextError] = useState(false);
  const alive = useRef(true);
  const draftRevision = useRef(0);
  const sendingRef = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const admit = async (action: () => Promise<boolean>, submittedText: string) => {
    if (sendingRef.current) return false;
    const revision = draftRevision.current;
    sendingRef.current = true; setSending(true); setTextError(false);
    try {
      const accepted = await action();
      if (!alive.current) return accepted;
      if (accepted && draftRevision.current === revision && draft.trim() === submittedText) setDraft("");
      if (!accepted) setTextError(true);
      return accepted;
    } catch (error: unknown) {
      console.warn("[aoede] message unavailable", error instanceof Error ? error.name : "UnknownError");
      if (alive.current) setTextError(true);
      return false;
    } finally { sendingRef.current = false; if (alive.current) setSending(false); }
  };
  const submit = () => !props.canSendText || !props.commands.sendText || props.pendingText || !draft.trim()
    ? Promise.resolve(false) : admit(() => props.commands.sendText!(draft), draft.trim());
  const retryPending = () => !props.pendingText || !props.commands.retryPendingText
    ? Promise.resolve(false) : admit(() => props.commands.retryPendingText!(), props.pendingText.text);
  const changeDraft = (value: string) => { draftRevision.current++; setDraft(value); };
  return { draft, changeDraft, sending, textError, submit, retryPending };
}
