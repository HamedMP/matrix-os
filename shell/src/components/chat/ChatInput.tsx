"use client";
import { useState, useRef, useEffect } from "react";
import { Attachments, AttachmentButton, useAttachments } from "@/components/ai-elements/attachments";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useVoice } from "@/hooks/useVoice";
import { SendIcon } from "@/lib/hugeicons";
import type { ChatSubmitOptions } from "@/hooks/useChatState";
import { ChatMentionControls, useChatMentionPermission, type ChatAgentClient } from "@matrix-os/ui";
import { ChatVoiceButton, ChatMentionTokens } from "./ChatInputExtras";
import { handleChatInputKey } from "./chat-input-keyboard";
import { chatInputPlaceholder, canSendChatInput } from "./chat-input-placeholder";
import { ChatMentionPicker } from "./ChatMentionPicker";
import type { ChatComposerDraft } from "./useChatComposerDraft";
export function ChatInput({
  composer, agentClient, scope, permissionMode,
  connected,
  busy,
  onSubmit,
  autoFocus,
  draftRequest,
  onDraftConsumed,
  unavailablePlaceholder,
  attachmentsEnabled,
}: {
  composer: ChatComposerDraft;
  agentClient?: ChatAgentClient;
  scope: string;
  permissionMode: string;
  connected: boolean;
  busy: boolean;
  onSubmit: (text: string, files?: Array<{ name: string; type: string; data: string }>, options?: ChatSubmitOptions) => void | Promise<boolean>;
  autoFocus?: boolean;
  draftRequest?: { id: number; text: string } | null;
  onDraftConsumed?: (id: number) => void;
  unavailablePlaceholder?: string;
  attachmentsEnabled: boolean;
}) {
  const { text: input, setText: setInput, resources } = composer;
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissedQuery, setDismissedQuery] = useState<string | null>(null);
  const queryMatch = /(?:^|\s)@([^\s@]*)$/.exec(input);
  const query = queryMatch && dismissedQuery !== input ? queryMatch[1]! : null;
  const permission = useChatMentionPermission(scope, resources, permissionMode);
  const mayQueue = resources.length > 0;


  const mentionListRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { attachments, addFiles, removeFile, clearAll, getBase64Files } = useAttachments();
  const canSend = canSendChatInput({ connected, sending, allowed: permission.allowed, busy, references: resources.length, text: input, attachments: attachments.length });

  const {
    isRecording,
    isTranscribing,
    isSupported,
    startRecording,
    stopRecording,
  } = useVoice({
    onTranscription: (text) => setInput(text),
    onError: (err) => console.error("Voice error:", err),
  });

  useEffect(() => {
    // react-doctor-disable-next-line react-doctor/no-event-handler -- focusing a DOM ref when the composer mounts or autoFocus turns on is a legitimate effect, not a user-event side effect that belongs in a parent handler
    if (autoFocus) textareaRef.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    if (!draftRequest) return;
    setInput(draftRequest.text);
    textareaRef.current?.focus();
    onDraftConsumed?.(draftRequest.id);
  }, [draftRequest, onDraftConsumed, setInput]);

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!canSend) return;
    const text = input.trim();
    setSending(true);
    setError(null);
    // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler cannot lower try/finally yet; the finally is required to release the submission guard on every failure.
    try {
      const files = attachments.length ? await getBase64Files() : undefined;
      const accepted = await onSubmit(text || (files?.length ? `Attached ${files.length} file(s)` : ""), files, {
        resources, clientRequestId: composer.requestId || crypto.randomUUID(), permissionMode: permission.permissionMode,
      });
      if (accepted !== false) { composer.clear(); clearAll(); }
    } catch (failure: unknown) {
      console.warn("[chat] Message submission failed:", failure instanceof Error ? failure.name : "UnknownError");
      setError("Message could not be sent. Try again.");
    } finally { setSending(false); }
  };

  const handleMicClick = () => {
    if (isRecording) stopRecording();
    else startRecording();
  };

  return (
    <div className="flex flex-col gap-2">
      <ChatMentionPicker listRef={mentionListRef} onDismiss={() => { setDismissedQuery(input); textareaRef.current?.focus(); }} client={agentClient} scope={scope} query={query} resources={resources} onSelect={(resource) => {
        composer.setResources([...resources, resource]);
        setInput(input.replace(/@[^\s@]*$/, ""));
        textareaRef.current?.focus();
      }} />
      <ChatMentionTokens resources={resources} onRemove={(resource) => composer.setResources(resources.filter((item) => item !== resource))} />
      <ChatMentionControls client={agentClient} resources={resources} permissionMode={permissionMode} confirmed={permission.confirmed} onConfirm={permission.confirm} />
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      <Attachments attachments={attachments} onRemove={removeFile} />
      <div className="relative flex items-end rounded-2xl border border-border/60 bg-card/80 shadow-sm transition-shadow focus-within:shadow-md focus-within:border-border">
        <AttachmentButton
          onFilesSelected={addFiles}
          disabled={!connected || !attachmentsEnabled}
          title={attachmentsEnabled ? "Attach files" : "Attachments are unavailable for this harness"}
          className="mb-2.5 ml-3"
        />
        <Textarea
          aria-label="Message chat"
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(event) => handleChatInputKey(event, { query, mentionListRef, onDismiss: () => setDismissedQuery(input), onSubmit: () => void handleSubmit() })}
          placeholder={chatInputPlaceholder({ transcribing: isTranscribing, recording: isRecording, connected, unavailable: unavailablePlaceholder })}
          disabled={!connected || isRecording}
          rows={1}
          className="border-0 bg-transparent shadow-none focus-visible:ring-0 text-sm min-h-0 max-h-40 resize-none py-3 px-2 flex-1"
        />
        <div className="flex items-center gap-0.5 mb-2 mr-2">
          {isSupported ? <ChatVoiceButton connected={connected} recording={isRecording} transcribing={isTranscribing} onClick={handleMicClick} /> : null}
          <Button
            type="button"
            aria-label={busy && mayQueue ? "Queue next" : "Send"}
            size="icon"
            className="size-8 rounded-full"
            disabled={!canSend}
            onClick={() => handleSubmit()}
          >
            <SendIcon className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
