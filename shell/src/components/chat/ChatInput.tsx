"use client";
import { randomUUID } from "@matrix-os/ui/random-uuid";
import { MAX_AGENT_ATTACHMENT_BYTES, mergeTrySuggestion, type CanonicalProviderInstanceDescriptor, type TrySuggestionDraft } from "@matrix-os/contracts";
import { createComposerSendHandoff, matchChatSlashToken, ProjectSkillDraftChips, useProjectSkillDraft, type ProjectChatSlashScope } from "@matrix-os/ui";
import { ChatSlashPicker } from "./ChatSlashPicker";
import { MatrixAttachmentPicker } from "./MatrixAttachmentPicker";
import { useMatrixAttachment } from "./use-matrix-attachment";
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
import { Attachments } from "@/components/ai-elements/attachments";
import { ATTACHMENT_COUNT_LIMIT, encodeChatAttachments } from "@/components/ai-elements/attachments-utils";
import { ChatMentionControls, useChatMentionPermission, useBotMentionNavigation, type ChatAgentClient } from "@matrix-os/ui";
import { ChatMentionTokens, FailedChatMessage } from "./ChatInputExtras";
import { handleChatInputKey } from "./chat-input-keyboard";
import { chatInputPlaceholder, canSendChatInput } from "./chat-input-placeholder";
import { ChatMentionPicker } from "./ChatMentionPicker";
import type { ChatComposerDraft, FailedChatSend, WebChatSubmitOptions } from "./useChatComposerDraft";
import {
  BrowserSpeechClientError,
  createBrowserSpeechClient,
  type BrowserSpeechClient,
} from "@/lib/platform-speech-client";
import {
  createWebPcmSpeechCaptureAdapter,
  PlatformSpeechRecorderError,
} from "@/lib/platform-speech-recorder";

type ChatSendFiles = Array<{ name: string; type: string; data: string }>;

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
  setupAnswer = false,
  leadingControls,
  toolbarControls,
  terminalControlPending,
  onChooseManagedTerminal,
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
  onSubmit: (text: string, files?: ChatSendFiles, options?: WebChatSubmitOptions) => void | Promise<boolean>;
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
  setupAnswer?: boolean;
  /** Controls after attach (+), such as the project picker, like Electron Desktop. */
  leadingControls?: React.ReactNode;
  /** Model, effort and access pickers, rendered before Send/Stop like Electron Desktop. */
  toolbarControls?: React.ReactNode;
  terminalControlPending?: boolean;
  onChooseManagedTerminal?: () => void;
  /** Queued turns, attached above the prompt card. */
  queue?: React.ReactNode;
}) {
  const { text: input, setText: setInput, setDraft, resources, failedSend, clearFailedSend } = composer;
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissedQuery, setDismissedQuery] = useState<string | null>(null);
  const [cursor, setCursor] = useState(input.length);
  const [slashDismissal, setSlashDismissal] = useState<string|null>(null);
  const skillBinding = JSON.stringify([scope, composer.permissionIdentity, projectSlash?.scope, projectSlash?.projectId, Boolean(projectSlash?.read), slashInstance?.id]);
  const projectSkillDraft = useProjectSkillDraft(skillBinding);
  const slashToken = setupAnswer ? null : matchChatSlashToken(input,cursor);
  const slashKey = JSON.stringify([skillBinding, input, slashToken?.start]);
  const slashQuery = slashToken && slashDismissal !== slashKey ? slashToken.query : null;
  const slashListRef = useRef<HTMLDivElement|null>(null);
  const slashAnchorRef = useRef<HTMLDivElement|null>(null);
  const queryMatch = setupAnswer ? null : /(?:^|\s)@([^\s@]*)$/.exec(input);
  const query = queryMatch && dismissedQuery !== input ? queryMatch[1]! : null;
  const permissionResources = botConsentResources.length ? botConsentResources : resources;
  const permission = useChatMentionPermission(scope, permissionResources, permissionMode, composer.permissionIdentity);
  const referenceCount = resources.length + projectSkillDraft.paths.length;
  const mayQueue = !setupAnswer && referenceCount > 0;
  const canAbort = Boolean(activeRunId && onAbortCurrent);


  const mentionListRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef(input);
  const pendingCursor = useRef<number|null>(null);
  const consumedDraftRequest = useRef<number | null>(null);
  // The last merged suggestion, to tell an untouched suggestion from the owner's own words.
  const mergedDraft = useRef<TrySuggestionDraft | null>(null);
  const { attachments, addAttachments, removeAttachment } = composer;
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
    onAdd: file => addAttachments([file]),
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
  const blockedDriveContext = !setupAnswer && resources.some(resource => resource.kind === "organization_drive") && !contextEnabled;
  const canSend = (setupAnswer || !failedSend) && !terminalControlPending && (!botRequiresFullAccess || permission.confirmed) && !blockedDriveContext && !speechBusy && !matrixAttachment.pending && canSendChatInput({ connected, sending, busy, references: setupAnswer ? 0 : referenceCount, text: input, attachments: setupAnswer ? 0 : attachments.length });
  const canRetry = !setupAnswer && failedSend && !failedSend.submission?.managedTerminalControl && !speechBusy && !matrixAttachment.pending
    && permissionMode === failedSend.permissionMode
    && (attachmentsEnabled || !failedSend.files.length)
    && (contextEnabled || !failedSend.options.resources.some(resource => resource.kind === "organization_drive"))
    && (!failedSend.options.projectSkillProjectId || (
      projectSlash?.projectId === failedSend.options.projectSkillProjectId && projectSlash.read
      && projectSlash.scope === failedSend.projectScope && slashInstance?.id === failedSend.harnessId
    ))
    && canSendChatInput({ connected, sending, busy, references: failedSend.options.resources.length + Number(Boolean(failedSend.options.projectSkillProjectId)), text: failedSend.prompt, attachments: failedSend.files.length });

  const retryFailedSend = async () => {
    if (!failedSend || !canRetry || !(isCurrentAuthority?.() ?? true)) return;
    const attachmentError = attachmentPolicy?.(failedSend.files);
    if (attachmentError) { setError(attachmentError); return; }
    const requestId = failedSend.options.clientRequestId;
    setSending(true);
    setError(null);
    try {
      const files = failedSend.files.length ? await encodeChatAttachments(failedSend.files) : undefined;
      const accepted = await onSubmit(failedSend.prompt, files, {
        ...failedSend.options,
        retrySubmission: failedSend.submission,
        onAccepted: chatId => {
          if (chatId) composer.moveDraft(chatId);
          clearFailedSend(requestId);
        },
      });
      if (accepted !== false) clearFailedSend(requestId);
    } catch (failure: unknown) {
      console.warn("[chat] Message retry failed:", failure instanceof Error ? failure.name : "UnknownError");
    }
    setSending(false);
  };

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
    element.style.height = `${Math.min(Math.max(contentHeight, setupAnswer ? 24 : 40), 220)}px`;
    element.style.overflowY = contentHeight > 220 ? "auto" : "hidden";
  }, [input, setupAnswer]);

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
    const attachmentError = !setupAnswer && attachmentPolicy?.(attachments.map(item => item.file));
    if (attachmentError) { setError(attachmentError); return; }
    const text = input.trim();
    const projectSkillProjectId = !setupAnswer && projectSkillDraft.paths.length ? projectSlash?.projectId : undefined;
    const preserveSkillSelection = Boolean(projectSkillProjectId && composer.permissionIdentity);
    let draftCleared = false;
    const sameDraft = () => currentComposer.current.scope === scope
      && (draftCleared || currentComposer.current.composer.requestId === composer.requestId);
    const currentSkillScope = () => projectSkillDraft.isCurrent() && sameDraft() && (isCurrentAuthority?.() ?? true);
    if (projectSkillProjectId && !currentSkillScope()) return;
    setSending(true);
    setError(null);
    const submittedIds = attachments.map(item => item.id);
    const submittedDraft = { text: composer.text, resources: composer.resources, attachments,
      requestId: composer.requestId, permissionIdentity: composer.permissionIdentity };
    const submissionOptions = {
      resources, clientRequestId: composer.requestId || randomUUID(), permissionMode: permission.permissionMode,
      ...(projectSkillProjectId ? { projectSkillProjectId } : {}),
    };
    let retry: FailedChatSend | undefined;
    const settleSubmission = () => {
      permission.confirm(false);
      projectSkillDraft.clear();
    };
    // The draft leaves the composer when its message shows, and comes back if the send is not admitted.
    const handoff = createComposerSendHandoff({
      clear: () => {
        if (!sameDraft() || (projectSkillProjectId && !currentSkillScope())) return false;
        draftCleared = true;
        composer.clear({ retainIdentity: preserveSkillSelection, sentAttachmentIds: submittedIds });
        return true;
      },
      restore: () => {
        draftCleared = false;
        if (!retry) return;
        const keepForRetry = Boolean(retry.unconfirmed || retry.files.length || (projectSkillProjectId && !projectSkillDraft.isCurrent()));
        composer.restore(submittedDraft, retry, keepForRetry);
        if (keepForRetry || composer.hasNewerDraft(submittedDraft)) projectSkillDraft.clear();
      },
      settle: cleared => {
        clearFailedSend(submissionOptions.clientRequestId);
        if (cleared) {
          if (preserveSkillSelection) composer.clear();
          if (currentComposer.current.scope === scope) settleSubmission();
          return;
        }
        if (!sameDraft() || (projectSkillProjectId && !currentSkillScope())) return;
        composer.clear({ sentAttachmentIds: submittedIds }); settleSubmission();
      },
    });
    // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler cannot lower try/finally yet; the finally is required to release the submission guard on every failure.
    try {
      if (setupAnswer) {
        if ((await onSubmit(text, undefined, { resources: [] })) !== false && sameDraft()) composer.clear();
        return;
      }
      const attachedFiles = attachments.map(({ file }) => file);
      const files = attachedFiles.length ? await encodeChatAttachments(attachedFiles) : undefined;
      if (projectSkillProjectId && !currentSkillScope()) return;
      const prompt = projectSkillDraft.prompt(text || (files?.length ? `Attached ${files.length} file(s)` : ""));
      const submitted: FailedChatSend = { text, prompt, files: attachedFiles, options: submissionOptions,
        projectScope: projectSlash?.scope, harnessId: slashInstance?.id, permissionMode };
      retry = submitted;
      const accepted = await onSubmit(prompt, files, {
        ...submissionOptions,
        onPrepared: submission => { submitted.submission = submission; },
        onAdmissionUnconfirmed: () => { submitted.unconfirmed = true; },
        onAccepted: chatId => {
          handoff.accepted();
          if (chatId) composer.moveDraft(chatId);
        },
        onShown: handoff.shown,
      });
      if (accepted !== false) handoff.accepted(); else handoff.rejected();
    } catch (failure: unknown) {
      const current = !projectSkillProjectId || currentSkillScope();
      handoff.rejected();
      if (!current) return;
      console.warn("[chat] Message submission failed:", failure instanceof Error ? failure.name : "UnknownError");
      setError("Message could not be sent. Try again.");
    } finally { setSending(false); }
  };

  const editorPlaceholder = connected || setupAnswer ? placeholder : chatInputPlaceholder({ transcribing: false, recording: false, connected, unavailable: unavailablePlaceholder });

  function addFilesFromInput(list: FileList, validateSize = true) {
    if (list.length + attachments.length > ATTACHMENT_COUNT_LIMIT) {
      setError(`A message carries up to ${ATTACHMENT_COUNT_LIMIT} attachments.`);
      return;
    }
    const files = Array.from(list);
    if (validateSize && files.some(file => file.size > MAX_AGENT_ATTACHMENT_BYTES)) {
      setError("A file exceeds the attachment size limit.");
      return;
    }
    setError(null);
    addAttachments(files);
  }

  return (
    <div className="matrix-chat-composer @container/chat-composer relative flex flex-col gap-2" data-slot="chat-composer" data-project-setup-answer={setupAnswer || undefined}
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
        } else addFilesFromInput(transfer.files);
      }}
      onPaste={event => {
        if (!attachmentsEnabled || !connected || sending || !event.clipboardData?.files?.length) return;
        if (!event.clipboardData.getData("text/plain")) event.preventDefault();
        addFilesFromInput(event.clipboardData.files);
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
      {!setupAnswer && failedSend ? <FailedChatMessage text={failedSend.text} canRetry={Boolean(canRetry)} sending={sending} unconfirmed={failedSend.unconfirmed}
        onRetry={() => void retryFailedSend()} onDiscard={() => clearFailedSend(failedSend.options.clientRequestId)} /> : null}
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
          onChooseManagedTerminal={onChooseManagedTerminal && slashToken ? () => {
            const suffixLength = input.slice(slashToken.end).match(/^[a-z0-9_.-]*/i)?.[0].length ?? 0;
            setInput(input.slice(0, slashToken.start) + input.slice(slashToken.end + suffixLength));
            setSlashDismissal(slashKey);
            onChooseManagedTerminal();
          } : undefined}
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
            // Keep picker selections editable so submit can explain any provider size limit.
            if (attachmentsEnabled && event.target.files?.length) addFilesFromInput(event.target.files, false);
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
              <Attachments attachments={attachments} onRemove={removeAttachment} />
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
                rows={setupAnswer ? 1 : 2}
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
              <ChatSpeechInputButton speech={speech} disabled={busy && !mayQueue} />
              {botControls ?? toolbarControls}
            </>
          )}
        />
      </div>
    </div>
  );
}
