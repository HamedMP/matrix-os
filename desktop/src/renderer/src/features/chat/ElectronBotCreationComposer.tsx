import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CanonicalProviderCatalog } from "@matrix-os/contracts";
import { SharedChatComposer } from "./SharedChatComposer";

export interface ElectronBotCreationComposerProps {
  scopeKey: string;
  value: string;
  onChange: (text: string) => void;
  onSubmit: (text: string) => Promise<boolean>;
  pending: boolean;
  available: boolean;
  catalog: CanonicalProviderCatalog;
  isCurrent: () => boolean;
  onAbort?: () => void;
}

/** Models and account settings belong to the shared creation Details panel. */
export function ElectronBotCreationComposer(props: ElectronBotCreationComposerProps) {
  return <ScopedComposer key={props.scopeKey} {...props}/>;
}

function ScopedComposer(props: ElectronBotCreationComposerProps) {
  const { scopeKey, value, onChange, pending, available, catalog, onAbort } = props;
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false), inFlight = useRef(false), currentText = useRef(value);
  useLayoutEffect(() => { currentText.current = value; }, [value]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const isCurrent = () => mounted.current && props.isCurrent();
  const submit = async (text: string) => {
    if (!isCurrent() || !available || pending || inFlight.current || !text.trim()) return;
    const original = value;
    inFlight.current = true;
    setSending(true); setError(null);
    try {
      const accepted = await props.onSubmit(text.trim());
      if (isCurrent() && accepted && currentText.current === original) onChange("");
    } catch (failure: unknown) {
      console.warn("Bot creation message failed", failure instanceof Error ? failure.name : "UnknownError");
      if (isCurrent()) setError("Message could not be sent. Try again.");
    } finally {
      inFlight.current = false;
      // react-doctor-disable-next-line react-doctor/no-loading-flag-reset-outside-finally -- This reset is inside finally; the ownership guard prevents updating a replaced creation session.
      if (isCurrent()) setSending(false);
    }
  };
  return <>
    {error ? <p role="alert">{error}</p> : null}
    <SharedChatComposer value={value} onChange={text => { if (isCurrent()) onChange(text); }}
      draftScopeKey={scopeKey} catalog={catalog} selection={null} instanceLocked automaticRouting
      onSelectionChange={() => {}} onSubmit={submission => { void submit(submission.text); }}
      busy={pending || sending} onAbort={onAbort} canSubmit={available && !pending && !sending && Boolean(value.trim())}
      speech={{ scopeKey, onDraft: text => { if (isCurrent()) onChange(`${currentText.current.trimEnd()} ${text}`.trimStart()); } }}/>
  </>;
}
