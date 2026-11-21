"use client";
import { MAX_AGENT_ATTACHMENT_BYTES, mergeTrySuggestion, type CanonicalProviderInstanceDescriptor, type TrySuggestionDraft } from "@matrix-os/contracts";
import { matchChatSlashToken, ProjectSkillDraftChips, useProjectSkillDraft, type ProjectChatSlashScope } from "@matrix-os/ui";
import { ChatSlashPicker } from "./ChatSlashPicker";
import { MatrixAttachmentPicker } from "./MatrixAttachmentPicker";
import { ATTACHMENT_COUNT_LIMIT, useMatrixAttachment } from "./use-matrix-attachment";
import { hasMatrixFileDrag, takeMatrixFileDrag } from "@/lib/matrix-file-drag";
import { usePreviewWindow } from "@/hooks/usePreviewWindow";
import {CompanyDriveContextControl} from "./CompanyDriveContextControl";
import {
  BOT_ATTACHMENT_HANDOFF_REASON,
  ChatComposerAttachButton,
  ChatPromptInput,
  ChatSpeechInputButton,
  ChatSpeechQuotaStatus,
  usePlatformSpeechDraft,
  type ChatAgentDraftRequest,
  type PlatformSpeechCaptureAdapter,
} from "@matrix-os/ui";

import { useState, useRef, useEffect, useLayoutEffect } from "react";
import { Attachments, useAttachments } from "@/components/ai-elements/attachments";
import type { ChatSubmitOptions } from "@/hooks/useChatState";
import { ChatMentionControls, useChatMentionPermission, useBotMentionNavigation, type ChatAgentClient } from "@matrix-os/ui";
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
  composer, agentClient, scope, permissionMode, onOpenBotMention, slashInstance, slashCatalogLoading = false, projectSlash, isCurrentAuthority,
  connected,
  busy,
  activeRunId,
  onAbortCurrent,
  onSubmit,
  autoFocus,
  draftRequest,
  onDraftConsumed,
  unavailablePlaceholder,
  attachmentsEnabled, attachmentPolicy, matrixGatewayUrl,
  driveContextEnabled = false,
  botContext = false,
  botControls, botConsentResources = [], botRequiresFullAccess = false,
  speechClient,
  speechCaptureAdapter,
  placeholder = "Reply to chat…",
  leadingControls,
  toolbarControls,
  queue,
}: {
  composer: ChatComposerDraft;
  slashInstance?: CanonicalProviderInstanceDescriptor;
  slashCatalogLoading?: boolean;
  projectSlash?: ProjectChatSlashScope;
  isCurrentAuthority?: () => boolean;
  onOpenBotMention?: (chatId: string, text: string) => boolean | Promise<boolean>;
  agentClient?: ChatAgentClient;
  scope: string;
  permissionMode: string;
  connected: boolean;
  busy: boolean;
  activeRunId?: string;
  onAbortCurrent?: () => void;
  onSubmit: (text: string, files?: Array<{ name: string; type: string; data: string }>, options?: ChatSubmitOptions) => void | Promise<boolean>;
  autoFocus?: boolean;
  draftRequest?: ChatAgentDraftRequest | null;
  onDraftConsumed?: (id: number) => void;
  unavailablePlaceholder?: string;
  attachmentsEnabled: boolean;
  attachmentPolicy?: (files: readonly File[]) => string | null;
  matrixGatewayUrl?: string;
  driveContextEnabled?: boolean;
  botContext?: boolean;
  botControls?: React.ReactNode;
  botRequiresFullAccess?: boolean;
  botConsentResources?: import("@matrix-os/contracts").CanonicalChatResourceReference[];
  speechClient?: BrowserSpeechClient;
  speechCaptureAdapter?: PlatformSpeechCaptureAdapter;
  placeholder?: string;
  /** Controls after attach (+), such as the project picker, like Electron Desktop. */
  leadingControls?: React.ReactNode;
  /** Model, effort and access pickers, rendered before Send/Stop like Electron Desktop. */
  toolbarControls?: React.ReactNode;
  /** Queued turns, attached above the prompt card. */
  queue?: React.ReactNode;
}) {
  const { text: input, setText: setInput, setDraft, resources } = composer;
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissedQuery, setDismissedQuery] = useState<string | null>(null);
  const [cursor, setCursor] = useState(input.length);
  const [slashDismissal, setSlashDismissal] = useState<string|null>(null);
  const skillBinding = JSON.stringify([scope, composer.permissionIdentity, projectSlash?.scope, projectSlash?.projectId, Boolean(projectSlash?.read), slashInstance?.id]);
  const projectSkillDraft = useProjectSkillDraft(skillBinding);
  const slashToken = matchChatSlashToken(input,cursor);
  const slashKey = JSON.stringify([skillBinding, input, slashToken?.start]);
  const slashQuery = slashToken && slashDismissal !== slashKey ? slashToken.query : null;
  const slashListRef = useRef<HTMLDivElement|null>(null);
  const slashAnchorRef = useRef<HTMLDivElement|null>(null);
  const queryMatch = /(?:^|\s)@([^\s@]*)$/.exec(input);
  const query = queryMatch && dismissedQuery !== input ? queryMatch[1]! : null;
  const permissionResources = botConsentResources.length ? botConsentResources : resources;
  const permission = useChatMentionPermission(scope, permissionResources, permissionMode, composer.permissionIdentity);
  const referenceCount = resources.length + projectSkillDraft.paths.length;
  const mayQueue = Boolean(activeRunId);
  const canAbort = Boolean(activeRunId && onAbortCurrent);


  const mentionListRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef(input);
  const pendingCursor = useRef<number|null>(null);
  const consumedDraftRequest = useRef<number | null>(null);
  // The last merged suggestion, to tell an untouched suggestion from the owner's own words.
  const mergedDraft = useRef<TrySuggestionDraft | null>(null);
  const { attachments, addFiles, removeFile, getBase64Files } = useAttachments();
  const fileAuthority = usePreviewWindow(state => state.draftAuthority);
  const [matrixPickerOpen, setMatrixPickerOpen] = useState(false);
  const matrixAttachment = useMatrixAttachment({
    authority: fileAuthority,
    enabled: attachmentsEnabled && connected && !sending,
    files: attachments.map(item => item.file),
    gatewayUrl: matrixGatewayUrl,
    isCurrentAuthority,
    policy: attachmentPolicy,
    scope: JSON.stringify([scope, composer.permissionIdentity]),
    onAdd: file => addFiles([file]),
  });
  const currentComposer = useRef({ composer, scope });
  useLayoutEffect(() => { currentComposer.current = { composer, scope }; }, [composer, scope]);
  const botMention = useBotMentionNavigation(agentClient, `${scope}:${composer.requestId}`, onOpenBotMention, attachments.length ? BOT_ATTACHMENT_HANDOFF_REASON : undefined);
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
  const contextEnabled = driveContextEnabled && !botContext;
  const blockedDriveContext = resources.some(resource => resource.kind === "organization_drive") && !contextEnabled;
  const canSend = (!busy || mayQueue) && (!botRequiresFullAccess || permission.confirmed) && !blockedDriveContext && !speechBusy && !matrixAttachment.pending && canSendChatInput({ connected, sending, busy, references: referenceCount, text: input, attachments: attachments.length });

  useEffect(() => {
    if (inputRef.current !== input) setCursor(input.length);
    inputRef.current = input;
    if (pendingCursor.current !== null) {
      textareaRef.current?.setSelectionRange(pendingCursor.current,pendingCursor.current);
      pendingCursor.current = null;
    }
  }, [input]);

  // Grow with the draft up to 220px, then scroll, like Electron Desktop's editor. Measured in
  // script because CSS `field-sizing` is not available in every browser Web Chat supports.
  useLayoutEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "0px";
    const contentHeight = element.scrollHeight;
    element.style.height = `${Math.min(Math.max(contentHeight, 40), 220)}px`;
    element.style.overflowY = contentHeight > 220 ? "auto" : "hidden";
  }, [input]);

  useEffect(() => {
    // react-doctor-disable-next-line react-doctor/no-event-handler -- focusing a DOM ref when the composer mounts or autoFocus turns on is a legitimate effect, not a user-event side effect that belongs in a parent handler
    if (autoFocus) textareaRef.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    if (!draftRequest || consumedDraftRequest.current === draftRequest.id) return;
    consumedDraftRequest.current = draftRequest.id;
    if (draftRequest.merge) {
      // The owner's own text stays; an earlier suggestion they have not touched is swapped.
      mergedDraft.current = mergeTrySuggestion(inputRef.current, mergedDraft.current, draftRequest.text);
      setDraft({ text: mergedDraft.current.text, resources });
    } else {
      mergedDraft.current = null;
      setDraft({ text: draftRequest.text, resources: draftRequest.resources ?? [] });
    }
    textareaRef.current?.focus();
    onDraftConsumed?.(draftRequest.id);
  }, [draftRequest, onDraftConsumed, resources, setDraft]);

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!canSend) return;
    const attachmentError = attachmentPolicy?.(attachments.map(item => item.file));
    if (attachmentError) { setError(attachmentError); return; }
    const text = input.trim();
    const projectSkillProjectId = projectSkillDraft.paths.length ? projectSlash?.projectId : undefined;
    const currentSkillScope = () => projectSkillDraft.isCurrent()
      && currentComposer.current.composer.requestId === composer.requestId
      && (isCurrentAuthority?.() ?? true);
    if (projectSkillProjectId && !currentSkillScope()) return;
    setSending(true);
    setError(null);
    const submittedIds = attachments.map(item => item.id);
    let acknowledged = false;
    const acknowledge = () => {
      if (acknowledged || currentComposer.current.scope !== scope || currentComposer.current.composer.requestId !== composer.requestId) return;
      if (projectSkillProjectId && !currentSkillScope()) return;
      acknowledged = true; permission.confirm(false); composer.clear();
      projectSkillDraft.clear();
      for (const id of submittedIds) removeFile(id);
    };
    // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler cannot lower try/finally yet; the finally is required to release the submission guard on every failure.
    try {
      const files = attachments.length ? await getBase64Files() : undefined;
      if (projectSkillProjectId && !currentSkillScope()) return;
      const prompt = projectSkillDraft.prompt(text || (files?.length ? `Attached ${files.length} file(s)` : ""));
      const accepted = await onSubmit(prompt, files, {
        resources, clientRequestId: composer.requestId || crypto.randomUUID(), permissionMode: permission.permissionMode, onAccepted: acknowledge,
        ...(projectSkillProjectId ? { projectSkillProjectId } : {}),
      });
      if (accepted !== false) acknowledge();
    } catch (failure: unknown) {
      if (projectSkillProjectId && !currentSkillScope()) return;
      console.warn("[chat] Message submission failed:", failure instanceof Error ? failure.name : "UnknownError");
      setError("Message could not be sent. Try again.");
    } finally { setSending(false); }
  };

  const editorPlaceholder = connected ? placeholder : chatInputPlaceholder({ transcribing: false, recording: false, connected, unavailable: unavailablePlaceholder });

  function addDroppedFiles(list: FileList) {
    if (list.length + attachments.length > ATTACHMENT_COUNT_LIMIT) {
      setError(`A message carries up to ${ATTACHMENT_COUNT_LIMIT} attachments.`);
      return;
    }
    const files = Array.from(list);
    if (files.some(file => file.size > MAX_AGENT_ATTACHMENT_BYTES)) {
      setError("A file exceeds the attachment size limit.");
      return;
    }
    setError(null);
    addFiles(files);
  }

  return (
    <div className="matrix-chat-composer @container/chat-composer relative flex flex-col gap-2" data-slot="chat-composer"
      onDragOver={event => {
        if (event.dataTransfer && (hasMatrixFileDrag(event.dataTransfer) || event.dataTransfer.types?.includes("Files"))) {
          event.preventDefault();
          event.dataTransfer.dropEffect = attachmentsEnabled && connected && !sending ? "copy" : "none";
        }
      }}
      onDrop={event => {
        const transfer = event.dataTransfer;
        if (!transfer) return;
        const isMatrix = hasMatrixFileDrag(transfer);
        if (!isMatrix && !transfer.files?.length) return;
        event.preventDefault();
        if (!attachmentsEnabled || !connected || sending) return;
        if (isMatrix) {
          const path = matrixGatewayUrl && takeMatrixFileDrag(transfer, fileAuthority, matrixGatewayUrl);
          if (path) {
            setError(null);
            void matrixAttachment.attach(path);
          } else if (matrixGatewayUrl) setError("Drag the file from the active Matrix Files window.");
        } else addDroppedFiles(transfer.files);
      }}
      onPaste={event => {
        if (!attachmentsEnabled || !connected || sending || !event.clipboardData?.files?.length) return;
        if (!event.clipboardData.getData("text/plain")) event.preventDefault();
        addDroppedFiles(event.clipboardData.files);
      }}>
      <ChatMentionPicker listRef={mentionListRef} onDismiss={() => { setDismissedQuery(input); textareaRef.current?.focus(); }} client={agentClient} scope={scope} query={query} resources={resources} onSelect={(resource) => {
        const text = input.replace(/@[^\s@]*$/, "");
        const insert = () => { composer.setResources([...resources, resource]); setInput(text); textareaRef.current?.focus(); };
        if (!botMention.select(resource, text.trimEnd(), insert)) insert();
      }} />
      <CompanyDriveContextControl botContext={botContext} identity={scope} resources={resources} enabled={contextEnabled} query={query} onSelect={resource => {
        composer.setResources([...resources, resource]);
        if (query !== null) setInput(input.replace(/@[^\s@]*$/, ""));
        textareaRef.current?.focus();
      }}/>
      <ChatMentionControls client={agentClient} resources={permissionResources} permissionMode={permissionMode} bot={botContext} requiresFullAccess={botRequiresFullAccess} confirmed={permission.confirmed} onConfirm={permission.confirm} />
      {botMention.pending ? <p role="status" className="text-xs">Opening bot Chat…</p> : null}
      {botMention.error || botMention.notice ? <p role="alert" className="text-xs">{botMention.error || botMention.notice}</p> : null}
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      {!matrixPickerOpen && matrixAttachment.error ? <p role="alert" className="text-xs text-destructive">{matrixAttachment.error}</p> : null}
      {!matrixPickerOpen && matrixAttachment.pending ? <p role="status" className="text-xs">Reading Matrix file…</p> : null}
      {matrixGatewayUrl && matrixPickerOpen ? <MatrixAttachmentPicker gatewayUrl={matrixGatewayUrl}
        pending={matrixAttachment.pending} error={matrixAttachment.error}
        chooseDevice={() => { matrixAttachment.clear(); setMatrixPickerOpen(false); fileInputRef.current?.click(); }}
        close={() => { matrixAttachment.clear(); setMatrixPickerOpen(false); textareaRef.current?.focus(); }}
        select={path => {
          void matrixAttachment.attach(path).then(attached => {
            if (!attached) return;
            setMatrixPickerOpen(false);
            requestAnimationFrame(() => textareaRef.current?.focus());
          });
        }} /> : null}
      <div ref={slashAnchorRef} className="relative flex flex-col">
        <ChatSlashPicker instance={slashInstance} loading={slashCatalogLoading} query={slashQuery} projectSlash={projectSlash} listRef={slashListRef} anchorRef={slashAnchorRef} inputRef={textareaRef}
          onOutsideDismiss={()=>setSlashDismissal(slashKey)}
          onDismiss={()=>{setSlashDismissal(slashKey);textareaRef.current?.focus();}} onSelect={entry=>{
            if (!slashToken) return;
            // Matching stops at the caret for filtering; replacement consumes the rest of the same token.
            const suffixLength=input.slice(slashToken.end).match(/^[a-z0-9_.-]*/i)?.[0].length ?? 0;
            let replacement = entry.invocation + " ";
            if (entry.kind === "project_skill") {
              if (isCurrentAuthority && !isCurrentAuthority()) return;
              if (!projectSkillDraft.select(entry.path)) return;
              replacement = "";
            }
            const next = input.slice(0, slashToken.start) + replacement + input.slice(slashToken.end + suffixLength);
            const nextCursor = slashToken.start + replacement.length;
            inputRef.current=next;pendingCursor.current=nextCursor;setCursor(nextCursor);setInput(next);
            setSlashDismissal(slashKey);textareaRef.current?.focus();
          }}/>
        {queue}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          aria-label="Attach files"
          onChange={(event) => {
            if (event.target.files?.length) addFiles(event.target.files);
            event.target.value = "";
          }}
        />
        <ChatPromptInput
          value={input}
          onChange={setInput}
          onSubmit={() => void handleSubmit()}
          onAbort={canAbort ? onAbortCurrent : undefined}
          busy={busy}
          submitWhileBusy={mayQueue}
          canSubmit={canSend}
          sendLabel={busy && mayQueue ? "Queue next" : "Send"}
          placeholder={editorPlaceholder}
          attachments={attachments.length || resources.length || projectSkillDraft.paths.length ? (
            <div data-slot="composer-context-row" className="flex min-w-0 flex-col gap-2 px-4 pt-3">
              <ProjectSkillDraftChips paths={projectSkillDraft.paths} onRemove={projectSkillDraft.remove} />
              <ChatMentionTokens resources={resources} onRemove={(resource) => composer.setResources(resources.filter((item) => item !== resource))} />
              <Attachments attachments={attachments} onRemove={removeFile} />
            </div>
          ) : null}
          editor={(
            <div data-slot="prompt-input-content" className="px-4">
              <textarea
                aria-label="Message chat"
                ref={textareaRef}
                value={input}
                onChange={(e) => {inputRef.current=e.target.value;setInput(e.target.value);setCursor(e.target.selectionStart);}}
                onSelect={e=>setCursor(e.currentTarget.selectionStart)}
                onKeyDown={(event) => {
                  if (slashQuery !== null && !event.nativeEvent.isComposing) {
                    if (event.key === "Escape") {event.preventDefault();setSlashDismissal(slashKey);return;}
                    if (event.key === "ArrowDown" || event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      const first=slashListRef.current?.querySelector<HTMLButtonElement>('button[role="option"]');
                      if (event.key === "Enter") first?.click(); else first?.focus();
                      return;
                    }
                  }
                  handleChatInputKey(event, { query, mentionListRef, onDismiss: () => setDismissedQuery(input), onSubmit: () => void handleSubmit() });
                }}
                placeholder={editorPlaceholder}
                rows={2}
                className="block max-h-[220px] min-h-10 w-full resize-none border-0 bg-transparent p-0 text-[14px] leading-[20px] text-[var(--text-primary)] shadow-none outline-none placeholder:text-[var(--text-tertiary)] focus-visible:outline-none focus-visible:ring-0"
              />
            </div>
          )}
          controls={(
            <>
              {attachmentsEnabled ? <ChatComposerAttachButton disabled={!connected} onClick={() => fileInputRef.current?.click()} /> : null}
              {attachmentsEnabled && matrixGatewayUrl ? <button type="button"
                disabled={!connected || sending || matrixAttachment.pending}
                className="h-7 shrink-0 rounded-lg border border-[var(--border-subtle)] px-2 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-40"
                onClick={() => { matrixAttachment.clear(); setMatrixPickerOpen(true); }}>Matrix Files</button> : null}
              {leadingControls}
            </>
          )}
          status={<ChatSpeechQuotaStatus speech={speech} />}
          trailingControls={(
            <>
              <ChatSpeechInputButton speech={speech} disabled={sending} />
              {botControls ?? toolbarControls}
            </>
          )}
        />
      </div>
    </div>
  );
}
