import type { AgentProviderSummary } from "@matrix-os/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConversationTranscript } from "../../components/conversation/transcript";
import { useConnection } from "../../stores/connection";
import { useBoard } from "../../stores/board";
import { useCodingAgentWorkspace } from "../../stores/coding-agent-workspace";
import { useHermesChat, type HermesStatus } from "../../stores/hermes-chat";
import { useTabs } from "../../stores/tabs";
import { useProviderPreferences } from "../settings/provider-preferences";
import { AttachmentPreviewRow } from "./attachments/AttachmentPreviewRow";
import { appendHermesAttachmentPaths } from "./attachments/local-attachment-controller";
import { useConversationAttachments } from "./attachments/use-conversation-attachments";
import { ChatStarterCards } from "./ChatStarterCards";
import {
  SharedChatComposer,
  type ComposerReferenceToken,
  type SharedChatComposerSubmission,
} from "./SharedChatComposer";
import { SharedChatSurface } from "./SharedChatSurface";
import {
  createLegacyGlobalProviderCatalog,
  filterCatalogForLegacyGlobal,
  legacyGlobalSelectionExecutable,
} from "./canonical-composer-adapter";
import {
  applyCanonicalComposerPreference,
  createCanonicalComposerSelection,
  type CanonicalComposerSelection,
} from "./canonical-composer-state";
import { useChatProviderCatalog } from "./chat-provider-catalog";
import { searchGlobalChatResources } from "./chat-resource-search";
import { useProviderSetup } from "./use-provider-setup";
import { ConversationContextFeedback } from "./ConversationContextComposer";
import ConversationContextPicker from "./ConversationContextPicker";
import { hermesConversationPresentation } from "./hermes-presentation";
import { HermesConversationIndex } from "./HermesConversationIndex";
import { CanonicalChatRoute } from "./CanonicalChatRoute";

const EMPTY_PROVIDER_SUMMARIES: AgentProviderSummary[] = [];

export function canSubmitChatDraft(
  draft: string,
  status: HermesStatus,
  attachmentCount = 0,
  contextBlocksSend = false,
  referenceCount = 0,
): boolean {
  return (draft.trim().length > 0 || attachmentCount > 0 || referenceCount > 0)
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
  const providerInstanceLocked = useHermesChat((state) => state.providerInstanceLocked);
  const send = useHermesChat((state) => state.send);
  const newChat = useHermesChat((state) => state.newChat);
  const abort = useHermesChat((state) => state.abort);
  const updateConversationContext = useHermesChat((state) => state.updateConversationContext);
  const recordRecentHermesConversation = useTabs((state) => state.recordRecentHermesConversation);
  const setDefaultProvider = useProviderPreferences((state) => state.setDefaultProvider);
  const composerSelections = useProviderPreferences((state) => state.composerSelections);
  const setComposerSelection = useProviderPreferences((state) => state.setComposerSelection);
  const [draft, setDraft] = useState("");
  const [referenceTokens, setReferenceTokens] = useState<ComposerReferenceToken[]>([]);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachments = useConversationAttachments(sessionId);
  const projects = useBoard((state) => state.projects);
  const fallbackCatalog = useMemo(
    () => createLegacyGlobalProviderCatalog({ hasProject: projects.length > 0 }),
    [projects.length],
  );
  const canonicalProviderCatalog = useChatProviderCatalog(fallbackCatalog).catalog;
  const providerCatalog = useMemo(
    () => filterCatalogForLegacyGlobal(canonicalProviderCatalog),
    [canonicalProviderCatalog],
  );
  const runtimeProviderSummary = useCodingAgentWorkspace((state) => state.summary);
  const runtimeProviderStatus = useCodingAgentWorkspace((state) => state.status);
  const refreshRuntimeProviderSummary = useCodingAgentWorkspace((state) => state.refresh);
  const [canonicalSelection, setCanonicalSelection] = useState<CanonicalComposerSelection | null>(
    () => createCanonicalComposerSelection(fallbackCatalog, "hermes_default"),
  );
  const handleProviderSetup = useProviderSetup(
    runtimeProviderSummary?.providers ?? EMPTY_PROVIDER_SUMMARIES,
    refreshRuntimeProviderSummary,
  );

  useEffect(() => {
    if (!api || runtimeProviderStatus !== "idle") return;
    void refreshRuntimeProviderSummary();
  }, [api, refreshRuntimeProviderSummary, runtimeProviderStatus]);

  useEffect(() => {
    setCanonicalSelection((current) => {
      if (current && providerCatalog.instances.some((instance) => (
        instance.id === current.instanceId
        && instance.models.some((model) => model.id === current.model && model.availability === "available")
      ))) return applyCanonicalComposerPreference(
        providerCatalog,
        current,
        composerSelections[current.instanceId],
      );
      const next = createCanonicalComposerSelection(providerCatalog);
      return next
        ? applyCanonicalComposerPreference(providerCatalog, next, composerSelections[next.instanceId])
        : null;
    });
  }, [composerSelections, providerCatalog]);

  useEffect(() => {
    void useProviderPreferences.getState().hydrate();
  }, []);

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

  const submit = async (submission: SharedChatComposerSubmission) => {
    const selectedInstance = providerCatalog.instances.find((candidate) => (
      candidate.id === canonicalSelection?.instanceId
    ));
    const supportsNativeAttachments = selectedInstance?.supports.attachments.some((kind) => (
      kind === "file" || kind === "image"
    )) ?? false;
    if (
      uploadingAttachments
      || !legacyGlobalSelectionExecutable(providerCatalog, canonicalSelection)
      || (attachments.items.length > 0 && !supportsNativeAttachments)
      || !canSubmitChatDraft(
        draft,
        status,
        attachments.items.length,
        contextPreventsSend,
        referenceTokens.length,
      )
    ) return;
    setUploadingAttachments(true);
    try {
      const uploaded = await attachments.uploadAll();
      if (!uploaded.ok) return;
      const submittedDraft = submission.text;
      send(appendHermesAttachmentPaths(submission.agentPrompt, uploaded.paths));
      if (sessionId) {
        const knownTitle = useHermesChat.getState().conversations
          .find((conversation) => conversation.id === sessionId)?.title;
        const label = submittedDraft.replace(/\s+/g, " ").slice(0, 80)
          || submission.invocations[0]?.invocation
          || submission.resources[0]?.label
          || knownTitle
          || "Shared files";
        recordRecentHermesConversation(sessionId, label);
      }
      setDraft("");
      setReferenceTokens([]);
      attachments.clear();
    } finally {
      setUploadingAttachments(false);
    }
  };

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
  const composerReady = legacyGlobalSelectionExecutable(providerCatalog, canonicalSelection)
    && canSubmitChatDraft(
    draft,
    status,
    attachments.items.length,
    contextPreventsSend,
    referenceTokens.length,
    );
  const resourceSearch = useCallback((query: string) => {
    if (!api) return Promise.resolve([]);
    const projectId = conversationContext?.status === "ready" ? conversationContext.projectId : null;
    return searchGlobalChatResources(api, projectId, query);
  }, [api, conversationContext]);
  const projectContextControl = (
    <ConversationContextPicker
      context={conversationContext}
      disabled={contextControlsDisabled}
      compact={!conversationContext}
      triggerLabel={conversationContext ? undefined : "Choose project for chat"}
      onSelect={updateProjectContext}
      onRemove={() => updateProjectContext(null)}
    />
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
          referenceTokens={referenceTokens}
          onReferenceTokensChange={setReferenceTokens}
          onSubmit={(submission) => void submit(submission)}
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
            setComposerSelection(selection);
            setCanonicalSelection(selection);
          }}
          onProviderSetup={(instance, action) => void handleProviderSetup(instance, action)}
          onNewChat={newChat}
          instanceLocked={providerInstanceLocked}
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
          leadingControls={projectContextControl}
        />
        <ConversationContextFeedback
          context={conversationContext}
          disabled={contextControlsDisabled}
          error={contextError}
          onUpdate={updateProjectContext}
        />
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
    </SharedChatSurface>
  );
}

function LegacyChatTab() {
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

export default function ChatTab({
  active = true,
  initialChatId,
  initialView,
}: {
  active?: boolean;
  initialChatId?: string;
  initialView?: "index" | "draft" | "conversation";
}) {
  const api = useConnection((state) => state.api);
  return (
    <CanonicalChatRoute
      api={api}
      projectId={null}
      initialChatId={initialChatId}
      initialView={initialView}
      active={active}
      fallback={<LegacyChatTab />}
    />
  );
}
