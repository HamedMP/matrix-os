"use client";
import { useEffect, useRef, useState } from "react";
import type { AoedePanelProps } from "./AoedePanel.js";
/** Keeps edits made during admission and preserves failed drafts for explicit retry. */
export function useAoedeTextComposer(props: Pick<AoedePanelProps, "canSendText" | "commands">) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [textError, setTextError] = useState(false);
  const alive = useRef(true);
  const draftRevision = useRef(0);
  const sendingRef = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const submit = async () => {
    if (sendingRef.current || !props.canSendText || !props.commands.sendText || !draft.trim()) return;
    const revision = draftRevision.current;
    sendingRef.current = true; setSending(true); setTextError(false);
    try {
      const accepted = await props.commands.sendText(draft);
      if (!alive.current) return;
      if (accepted && draftRevision.current === revision) setDraft("");
      if (!accepted) setTextError(true);
    } catch (error: unknown) {
      console.warn("[aoede] message unavailable", error instanceof Error ? error.name : "UnknownError");
      if (alive.current) setTextError(true);
    } finally { sendingRef.current = false; if (alive.current) setSending(false); }
  };
  const changeDraft = (value: string) => { draftRevision.current++; setDraft(value); };
  return { draft, changeDraft, sending, textError, submit };
}
