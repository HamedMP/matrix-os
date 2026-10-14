"use client";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { ChatInput } from "./ChatInput";
import type { ChatComposerDraft } from "./useChatComposerDraft";

export interface WebBotCreationComposerProps {
  scopeKey: string;
  value: string;
  onChange: (text: string) => void;
  onSubmit: (text: string) => Promise<boolean>;
  pending: boolean;
  available: boolean;
  isCurrent: () => boolean;
  activeRunId?: string;
  onAbort?: () => void;
}
export function WebBotCreationComposer(props: WebBotCreationComposerProps) {
  return <ScopedComposer key={props.scopeKey} {...props}/>;
}
function ScopedComposer(props: WebBotCreationComposerProps) {
  const { scopeKey, value, pending, available, activeRunId, onAbort } = props;
  const mounted = useRef(false), current = useRef(props);
  useLayoutEffect(() => { current.current = props; }, [props]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // Stable writers prevent ChatInput from replaying a draft/focus effect on typing.
  const setText = useCallback((text: string) => {
    if (mounted.current && current.current.isCurrent()) current.current.onChange(text);
  }, []);
  const composer: ChatComposerDraft = {
    text: value, resources: [], requestId: scopeKey, permissionIdentity: scopeKey,
    setText, setResources: () => {},
    setDraft: useCallback((draft: { text?: string }) => { if (draft.text !== undefined) setText(draft.text); }, [setText]),
    seedChatDraft: () => false,
    // ChatInput clears after an accepted send; reject late clears after a new edit.
    clear: () => { if (current.current.value === value) setText(""); },
  };
  return <ChatInput composer={composer} scope={scopeKey} permissionMode="supervised" botContext
    connected={available} busy={pending} activeRunId={activeRunId} onAbortCurrent={onAbort}
    attachmentsEnabled={false} attachmentsUnavailableLabel="Attachments are unavailable while setting up an agent." onSubmit={text => {
      if (!mounted.current || !current.current.isCurrent()) return Promise.resolve(false);
      return props.onSubmit(text);
    }}/>;
}
