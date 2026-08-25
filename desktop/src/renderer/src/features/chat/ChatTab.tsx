import { FolderOpen, GitBranch } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConversationTranscript } from "../../components/conversation/transcript";
import { useConnection } from "../../stores/connection";
import { useBoard } from "../../stores/board";
import { useHermesChat, type HermesStatus } from "../../stores/hermes-chat";
import { useTabs } from "../../stores/tabs";
import { defaultProjectId, openProjectChat } from "../../lib/project-chat";
import { useProviderPreferences } from "../settings/provider-preferences";
import { AttachmentPreviewRow } from "./attachments/AttachmentPreviewRow";
import { appendHermesAttachmentPaths } from "./attachments/local-attachment-controller";
import { useConversationAttachments } from "./attachments/use-conversation-attachments";
import { ChatResourcesPanel } from "./ChatResourcesPanel";
import { ChatStarterCards } from "./ChatStarterCards";
import { SharedChatComposer } from "./SharedChatComposer";
import { SharedChatSurface } from "./SharedChatSurface";
import { createLegacyGlobalProviderCatalog } from "./canonical-composer-adapter";
import {
  createCanonicalComposerSelection,
  type CanonicalComposerSelection,
} from "./canonical-composer-state";
import { useChatProviderCatalog } from "./chat-provider-catalog";
import { searchHomeChatResources, searchProjectChatResources } from "./chat-resource-search";
import {
  ConversationContextControls,
  ConversationContextFeedback,
} from "./ConversationContextComposer";
import { hermesConversationPresentation } from "./hermes-presentation";
import { HermesConversationIndex } from "./HermesConversationIndex";

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

export function HermesPane() {
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
  const recordRecentHermesConversation = useTabs((state) => state.recordRecentHermesConversation);
  const setDefaultProvider = useProviderPreferences((state) => state.setDefaultProvider);
  const [draft, setDraft] = useState("");
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const [resourcesOpen, setResourcesOpen] = useState(false);
  const [harnessError, setHarnessError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const resourcesTriggerRef = useRef<HTMLButtonElement>(null);
  const attachments = useConversationAttachments(sessionId);
  const projects = useBoard((state) => state.projects);
  const codexProjectId = defaultProjectId();
  const fallbackCatalog = useMemo(
    () => createLegacyGlobalProviderCatalog({ hasProject: Boolean(codexProjectId) }),
    [codexProjectId],
  );
  const providerCatalog = useChatProviderCatalog(fallbackCatalog).catalog;
  const [canonicalSelection, setCanonicalSelection] = useState<CanonicalComposerSelection | null>(
    () => createCanonicalComposerSelection(fallbackCatalog, "hermes_default"),
  );

  useEffect(() => {
    setCanonicalSelection((current) => {
      if (current && providerCatalog.instances.some((instance) => (
        instance.id === current.instanceId
        && instance.models.some((model) => model.id === current.model && model.availability === "available")
      ))) return current;
      return createCanonicalComposerSelection(providerCatalog);
    });
  }, [providerCatalog]);

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

  const startProjectChat = useCallback(async (providerId = "codex"): Promise<boolean> => {
    const projectId = defaultProjectId();
    if (!projectId) {
      setHarnessError("Create a project before starting a Codex chat.");
      return false;
    }
    setHarnessError(null);
    setDefaultProvider(providerId);
    const opened = await openProjectChat(projectId, { compose: true });
    if (!opened) {
      setHarnessError("Codex chat could not be opened. Try again from the project.");
    }
    return opened;
  }, [setDefaultProvider]);

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
  const resourceSearch = useCallback((query: string) => {
    if (!api) return Promise.resolve([]);
    const projectId = conversationContext?.status === "ready" ? conversationContext.projectId : null;
    return projectId
      ? searchProjectChatResources(api, projectId, query)
      : searchHomeChatResources(api, query);
  }, [api, conversationContext]);
  const composerControls = (
    <>
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
      <button
        type="button"
        aria-label="Use Codex for a project chat"
        className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
        style={{ color: "var(--text-secondary)" }}
        onClick={() => void startProjectChat()}
      >
        <GitBranch size={15} aria-hidden />
      </button>
    </>
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
        <SharedChatComposer
          value={draft}
          onChange={setDraft}
          onSubmit={() => void submit()}
          onAbort={status !== "idle" ? abort : undefined}
          busy={status !== "idle" || uploadingAttachments}
          disabled={uploadingAttachments}
          canSubmit={composerReady}
          catalog={providerCatalog}
          selection={canonicalSelection}
          onSelectionChange={(selection) => {
            const instance = providerCatalog.instances.find((candidate) => candidate.id === selection.instanceId);
            const providerId = instance?.driverKind === "claude_code" ? "claude" : instance?.driverKind;
            if (providerId) setDefaultProvider(providerId);
            setCanonicalSelection(selection);
          }}
          instanceLocked={!empty}
          resources={projects.map((project) => ({
            kind: "project" as const,
            id: project.slug,
            label: project.name,
          }))}
          resourceSearch={resourceSearch}
          onAttach={() => fileInputRef.current?.click()}
          attachments={attachmentPreviews}
          autoFocus={autoFocus}
          placeholder={placeholder}
          ariaLabel={placeholder}
          leadingControls={composerControls}
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
    <SharedChatSurface
      ariaLabel="Hermes conversation"
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
            <h1
              className="text-[32px] font-semibold leading-tight tracking-[-0.02em]"
              style={{ color: "var(--text-primary)" }}
            >
              What should we build today?
            </h1>
          </div>
          <ChatStarterCards onSelect={setDraft} />
          <div className="shrink-0">{renderComposer("How can I help you today?", true)}</div>
        </div>
      ) : (
        <>
          <ConversationTranscript turns={turns} callbacks={{ copyText }} />
          <div className="mx-auto w-full max-w-[868px] shrink-0 px-5 pb-5">
            {renderComposer("Reply to Hermes…")}
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
    </SharedChatSurface>
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
