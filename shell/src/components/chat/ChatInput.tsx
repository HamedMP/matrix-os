"use client";
import {
  usePlatformSpeechDraft,
  type ChatAgentDraftRequest,
  type PlatformSpeechCaptureAdapter,
} from "@matrix-os/ui";

import { useState, useRef, useEffect } from "react";
import { Attachments, AttachmentButton, useAttachments } from "@/components/ai-elements/attachments";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { CircleStop, Loader2Icon, MicIcon, SendIcon, XCircleIcon } from "@/lib/hugeicons";
import type { ChatSubmitOptions } from "@/hooks/useChatState";
import { ChatMentionControls, useChatMentionPermission, type ChatAgentClient } from "@matrix-os/ui";
import { ChatMentionTokens } from "./ChatInputExtras";
import { handleChatInputKey } from "./chat-input-keyboard";
import { chatInputPlaceholder, canSendChatInput } from "./chat-input-placeholder";
import { ChatMentionPicker } from "./ChatMentionPicker";
import type { ChatComposerDraft } from "./useChatComposerDraft";
import {
  BrowserSpeechClientError,
  createBrowserSpeechClient,
  type BrowserSpeechClient,
} from "@/lib/platform-speech-client";
import {
  createWebPcmSpeechCaptureAdapter,
  PlatformSpeechRecorderError,
} from "@/lib/platform-speech-recorder";
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
  speechClient,
  speechCaptureAdapter,
}: {
  composer: ChatComposerDraft;
  agentClient?: ChatAgentClient;
  scope: string;
  permissionMode: string;
  connected: boolean;
  busy: boolean;
  onSubmit: (text: string, files?: Array<{ name: string; type: string; data: string }>, options?: ChatSubmitOptions) => void | Promise<boolean>;
  autoFocus?: boolean;
  draftRequest?: ChatAgentDraftRequest | null;
  onDraftConsumed?: (id: number) => void;
  unavailablePlaceholder?: string;
  attachmentsEnabled: boolean;
  speechClient?: BrowserSpeechClient;
  speechCaptureAdapter?: PlatformSpeechCaptureAdapter;
}) {
  const { text: input, setText: setInput, setDraft, resources } = composer;
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissedQuery, setDismissedQuery] = useState<string | null>(null);
  const queryMatch = /(?:^|\s)@([^\s@]*)$/.exec(input);
  const query = queryMatch && dismissedQuery !== input ? queryMatch[1]! : null;
  const permission = useChatMentionPermission(scope, resources, permissionMode, composer.permissionIdentity);
  const mayQueue = resources.length > 0;


  const mentionListRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = useRef(input);
  const { attachments, addFiles, removeFile, clearAll, getBase64Files } = useAttachments();
  const [defaultSpeechClient] = useState(() => createBrowserSpeechClient());
  const [defaultSpeechCapture] = useState(() => createWebPcmSpeechCaptureAdapter());
  const speech = usePlatformSpeechDraft({
    scopeKey: scope,
    client: speechClient ?? defaultSpeechClient,
    captureAdapter: speechCaptureAdapter ?? defaultSpeechCapture,
    safeErrorMessage: (caught) => caught instanceof BrowserSpeechClientError
      ? caught.safeMessage
      : caught instanceof PlatformSpeechRecorderError ? caught.safeMessage : undefined,
    onDraft: (text) => {
      const current = inputRef.current.trimEnd();
      setInput(current.length > 0 ? `${current} ${text}` : text);
    },
  });
  const speechBusy = speech.phase === "requesting_permission" || speech.phase === "recording" || speech.phase === "transcribing";
  const canSend = !speechBusy && canSendChatInput({ connected, sending, allowed: permission.allowed, busy, references: resources.length, text: input, attachments: attachments.length });

  useEffect(() => {
    inputRef.current = input;
  }, [input]);

  useEffect(() => {
    // react-doctor-disable-next-line react-doctor/no-event-handler -- focusing a DOM ref when the composer mounts or autoFocus turns on is a legitimate effect, not a user-event side effect that belongs in a parent handler
    if (autoFocus) textareaRef.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    if (!draftRequest) return;
    setDraft({ text: draftRequest.text, resources: draftRequest.resources ?? [] });
    textareaRef.current?.focus();
    onDraftConsumed?.(draftRequest.id);
  }, [draftRequest, onDraftConsumed, setDraft]);

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
    if (speech.phase === "recording") speech.stop();
    else if (speech.phase === "requesting_permission" || speech.phase === "transcribing") speech.cancel();
    else void speech.start();
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
      {speech.error ? <p role="alert" className="text-xs text-destructive">{speech.error}</p> : null}
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
          placeholder={speech.phase === "requesting_permission"
            ? "Waiting for microphone permission..."
            : speech.phase === "transcribing"
              ? "Transcribing into an editable draft..."
              : speech.phase === "recording"
                ? "Recording — stop when you're done"
                : chatInputPlaceholder({ transcribing: false, recording: false, connected, unavailable: unavailablePlaceholder })}
          rows={1}
          className="border-0 bg-transparent shadow-none focus-visible:ring-0 text-sm min-h-0 max-h-40 resize-none py-3 px-2 flex-1"
        />
        <div className="flex items-center gap-0.5 mb-2 mr-2">
          {speech.isSupported ? (
            <Button
              type="button"
              aria-label={speech.phase === "requesting_permission"
                ? "Cancel microphone request"
                : speech.phase === "recording"
                  ? "Stop recording"
                  : speech.phase === "transcribing"
                    ? "Cancel transcription"
                    : "Start voice input"}
              size="icon"
              variant="ghost"
              className={`size-8 rounded-full ${speech.phase === "recording" ? "text-destructive" : "text-muted-foreground hover:text-foreground"}`}
              onClick={handleMicClick}
            >
              {speech.phase === "requesting_permission" ? <Loader2Icon className="size-4 animate-spin" />
                : speech.phase === "transcribing" ? <XCircleIcon className="size-4" />
                  : speech.phase === "recording" ? <CircleStop className="size-4" />
                    : <MicIcon className="size-4" />}
            </Button>
          ) : null}
          {speech.phase === "recording" ? (
            <span aria-live="polite" className="px-1 text-xs tabular-nums text-muted-foreground">
              {Math.floor(speech.elapsedMs / 60_000)}:{String(Math.floor(speech.elapsedMs / 1_000) % 60).padStart(2, "0")}
            </span>
          ) : null}
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
