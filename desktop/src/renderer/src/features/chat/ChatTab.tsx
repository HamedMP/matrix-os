import { FolderOpen, Plus } from "lucide-react";
import type { GlobalChatProviderId } from "@matrix-os/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { BrandLogo } from "../../design/BrandPanel";
import { ConversationProviderSelector } from "../../components/conversation/provider-selector";
import { ConversationTranscript } from "../../components/conversation/transcript";
import { useConnection } from "../../stores/connection";
import { useCodingAgentWorkspace } from "../../stores/coding-agent-workspace";
import { useHermesChat, type HermesStatus } from "../../stores/hermes-chat";
import { useTabs } from "../../stores/tabs";
import { AttachmentPreviewRow } from "./attachments/AttachmentPreviewRow";
import { appendHermesAttachmentPaths } from "./attachments/local-attachment-controller";
import { useConversationAttachments } from "./attachments/use-conversation-attachments";
import { PromptInput } from "./elements/prompt-input";
import { ChatResourcesPanel } from "./ChatResourcesPanel";
import {
  ConversationContextControls,
  ConversationContextFeedback,
} from "./ConversationContextComposer";
import { hermesConversationPresentation } from "./hermes-presentation";
import { HermesConversationIndex } from "./HermesConversationIndex";
import { createGlobalChatProviderRegistry } from "./global-chat-providers";

export function canSubmitChatDraft(
  draft: string,
  status: HermesStatus,
  attachmentCount = 0,
  contextBlocksSend = false,
): boolean {
  return (draft.trim().length > 0 || attachmentCount > 0)
    && status === "idle"
    && !contextBlocksSend;
}

const GLOBAL_CHAT_PROVIDER_LABELS: Record<GlobalChatProviderId, string> = {
  claude: "Claude",
  codex: "Codex",
  pi: "Pi",
};

function HermesPane() {
  const api = useConnection((state) => state.api);
  const messages = useHermesChat((state) => state.messages);
  const sessionId = useHermesChat((state) => state.sessionId);
  const status = useHermesChat((state) => state.status);
  const activeRequestId = useHermesChat((state) => state.activeRequestId);
  const loadError = useHermesChat((state) => state.loadError);
  const conversationContext = useHermesChat((state) => state.conversationContext);
  const contextStatus = useHermesChat((state) => state.contextStatus);
  const contextError = useHermesChat((state) => state.contextError);
  const send = useHermesChat((state) => state.send);
  const abort = useHermesChat((state) => state.abort);
  const updateConversationContext = useHermesChat((state) => state.updateConversationContext);
  const providerId = useHermesChat((state) => state.providerId);
  const createConversation = useHermesChat((state) => state.createConversation);
  const recordRecentHermesConversation = useTabs((state) => state.recordRecentHermesConversation);
  const [draft, setDraft] = useState("");
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const [resourcesOpen, setResourcesOpen] = useState(false);
  const [harnessError, setHarnessError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const resourcesTriggerRef = useRef<HTMLButtonElement>(null);
  const attachments = useConversationAttachments(sessionId);
  const providerSummary = useCodingAgentWorkspace((state) => state.summary);
  const refreshProviderSummary = useCodingAgentWorkspace((state) => state.refresh);

  useEffect(() => {
    if (!api) return;
    void refreshProviderSummary();
  }, [api, refreshProviderSummary]);

  const turns = hermesConversationPresentation(messages, status, activeRequestId);
  const copyText = useCallback(async (text: string) => {
    if (!navigator.clipboard?.writeText) throw new Error("ClipboardUnavailable");
    await navigator.clipboard.writeText(text);
  }, []);
  const empty = messages.length === 0;
  const contextBlocksSend = conversationContext?.status === "unavailable";
  const contextMutationPending = contextStatus === "loading";
  const contextPreventsSend = contextBlocksSend || contextMutationPending;
  const contextControlsDisabled = status !== "idle"
    || uploadingAttachments
    || contextMutationPending
    || !api
    || !sessionId;

  const closeResources = useCallback((restoreFocus = true) => {
    setResourcesOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => resourcesTriggerRef.current?.focus());
    }
  }, []);

  const submit = async () => {
    if (
      uploadingAttachments
      || !canSubmitChatDraft(draft, status, attachments.items.length, contextPreventsSend)
    ) return;
    setUploadingAttachments(true);
    try {
      const uploaded = await attachments.uploadAll();
      if (!uploaded.ok) return;
      const submittedDraft = draft.trim();
      send(appendHermesAttachmentPaths(draft, uploaded.paths));
      if (sessionId) {
        const knownTitle = useHermesChat.getState().conversations
          .find((conversation) => conversation.id === sessionId)?.title;
        const label = submittedDraft.replace(/\s+/g, " ").slice(0, 80)
          || knownTitle
          || "Shared files";
        recordRecentHermesConversation(sessionId, label);
      }
      setDraft("");
      attachments.clear();
    } finally {
      setUploadingAttachments(false);
    }
  };

  const selectProvider = useCallback(async (nextProviderId: GlobalChatProviderId) => {
    if (nextProviderId === providerId) return;
    if (!api) {
      setHarnessError("Connect a computer before switching providers.");
      return;
    }
    setHarnessError(null);
    if (!await createConversation(api, nextProviderId)) {
      setHarnessError("A new provider conversation could not be created. Try again.");
    }
  }, [api, createConversation, providerId]);
  const providerRegistry = createGlobalChatProviderRegistry({
    selectedId: providerId,
    connected: Boolean(api),
    availableProviderIds: [
      ...(api ? ["claude" as const] : []),
      ...(providerSummary?.providers
        .filter((provider) => (
          (provider.id === "codex" || provider.id === "pi")
          && provider.availability === "available"
          && provider.installStatus === "installed"
          && provider.authStatus === "authenticated"
        ))
        .map((provider) => provider.id as "codex" | "pi") ?? []),
    ],
    onSelectProvider: selectProvider,
  });

  const attachmentPreviews = (
    <AttachmentPreviewRow
      items={attachments.items}
      disabled={uploadingAttachments}
      onRemove={attachments.remove}
      onRetry={(localId) => void attachments.retry(localId)}
    />
  );
  const updateProjectContext = useCallback((projectId: string | null) => {
    if (!api || !sessionId || contextControlsDisabled) return;
    void updateConversationContext(api, sessionId, projectId);
  }, [api, contextControlsDisabled, sessionId, updateConversationContext]);
  const composerReady = canSubmitChatDraft(
    draft,
    status,
    attachments.items.length,
    contextPreventsSend,
  );
  const composerControls = (
    <>
      <button
        type="button"
        aria-label="Attach files"
        className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
        style={{ color: "var(--text-secondary)" }}
        disabled={uploadingAttachments}
        onClick={() => fileInputRef.current?.click()}
      >
        <Plus size={16} aria-hidden />
      </button>
      <button
        ref={resourcesTriggerRef}
        type="button"
        aria-label="Resources"
        aria-expanded={resourcesOpen}
        className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-sm hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
        style={{ color: "var(--text-secondary)" }}
        onClick={() => setResourcesOpen((open) => !open)}
      >
        <FolderOpen size={15} aria-hidden />
      </button>
    </>
  );
  const harnessBadge = (
    <ConversationProviderSelector
      value={providerRegistry.selectedId}
      options={providerRegistry.options}
      onSelect={(providerId) => void providerRegistry.activate(providerId)}
    />
  );
  const contextStrip = (
    <div
      className="flex min-w-0 flex-col gap-2 px-1 text-sm"
      style={{ color: "var(--text-tertiary)" }}
    >
      <ConversationContextControls
        context={conversationContext}
        disabled={contextControlsDisabled}
        onUpdate={updateProjectContext}
      />
      <ConversationContextFeedback
        context={conversationContext}
        disabled={contextControlsDisabled}
        error={contextError}
        onUpdate={updateProjectContext}
      />
    </div>
  );
  const renderComposer = (placeholder: string, autoFocus = false) => (
    <>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        aria-label="Choose files"
        className="sr-only"
        onChange={(event) => {
          attachments.add(Array.from(event.currentTarget.files ?? []));
          event.currentTarget.value = "";
        }}
      />
      <div className="flex min-w-0 flex-col gap-2">
        <PromptInput
          value={draft}
          onChange={setDraft}
          onSubmit={() => void submit()}
          onAbort={status !== "idle" ? abort : undefined}
          busy={status !== "idle" || uploadingAttachments}
          disabled={uploadingAttachments}
          canSubmit={composerReady}
          attachments={attachmentPreviews}
          autoFocus={autoFocus}
          placeholder={placeholder}
          ariaLabel={placeholder}
          controls={composerControls}
          trailingControls={harnessBadge}
        />
        {contextStrip}
      </div>
    </>
  );

  const loadErrorBanner = loadError ? (
    <div role="alert" className="mx-auto mt-3 w-[calc(100%-2.5rem)] max-w-[868px] rounded-lg border px-3 py-2 text-sm" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>
      {loadError}
    </div>
  ) : null;

  return (
    <div
      role="region"
      aria-label="Global Chat conversation"
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
      {...attachments.paneProps}
    >
      {loadErrorBanner}
      {harnessError ? (
        <div role="alert" className="mx-auto mt-3 w-[calc(100%-2.5rem)] max-w-[868px] rounded-lg border px-3 py-2 text-sm" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>
          {harnessError}
        </div>
      ) : null}
      {empty ? (
        <div data-testid="chat-empty-content" className="mx-auto flex min-h-0 w-full max-w-[868px] flex-1 flex-col justify-center gap-[26px] px-5 py-8">
          <div className="flex shrink-0 flex-col items-center gap-[26px] text-center">
            <BrandLogo size={208} color="var(--text-primary)" testId="chat-empty-logo" />
            <h1
              className="text-[32px] font-medium leading-tight tracking-[-0.02em] sm:text-[36px]"
              style={{ color: "var(--text-primary)", fontFamily: '"Instrument Serif", Georgia, serif' }}
            >
              How can I help you?
            </h1>
          </div>
          <div className="shrink-0">{renderComposer(`Ask ${GLOBAL_CHAT_PROVIDER_LABELS[providerId]} anything…`, true)}</div>
        </div>
      ) : (
        <>
          <ConversationTranscript turns={turns} callbacks={{ copyText }} />
          <div className="mx-auto w-full max-w-[868px] shrink-0 px-5 pb-5">
            {renderComposer(`Reply to ${GLOBAL_CHAT_PROVIDER_LABELS[providerId]}…`)}
          </div>
        </>
      )}

      {resourcesOpen ? (
        <ChatResourcesPanel
          messages={messages}
          onClose={closeResources}
          onUpload={() => {
            fileInputRef.current?.click();
            closeResources(false);
          }}
        />
      ) : null}
    </div>
  );
}

export default function ChatTab() {
  const api = useConnection((state) => state.api);
  const conversationView = useHermesChat((state) => state.view);
  const indexStatus = useHermesChat((state) => state.indexStatus);
  const refreshConversations = useHermesChat((state) => state.refreshConversations);
  const indexAutoRetryCount = useRef(0);

  useEffect(() => {
    indexAutoRetryCount.current = 0;
  }, [api]);

  useEffect(() => {
    if (!api) return;
    if (indexStatus === "ready") {
      indexAutoRetryCount.current = 0;
      return;
    }
    if (indexStatus === "idle") {
      void refreshConversations(api);
      return;
    }
    if (indexStatus !== "error" || indexAutoRetryCount.current >= 2) return;

    const delayMs = 1_000 * (2 ** indexAutoRetryCount.current);
    indexAutoRetryCount.current += 1;
    const timeout = window.setTimeout(() => {
      void refreshConversations(api);
    }, delayMs);
    return () => window.clearTimeout(timeout);
  }, [api, indexStatus, refreshConversations]);

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {conversationView === "index" ? <HermesConversationIndex api={api} /> : <HermesPane />}
    </div>
  );
}
