import type { AgentProviderSummary, CanonicalChatDetailResponse } from "@matrix-os/contracts";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ConversationTranscript } from "../../components/conversation/transcript";
import { CHAT_CONTENT_WIDTH_CLASS } from "../../components/conversation/layout";
import { cn } from "../../lib/cn";
import type { CanonicalChatEventSource } from "../../lib/canonical-chat-client";
import { openFileInDesktopEditor } from "../editor/desktop-editor-store";
import { Button } from "../../design/primitives";
import { useConnection } from "../../stores/connection";
import { useBoard } from "../../stores/board";
import { useCodingAgentWorkspace } from "../../stores/coding-agent-workspace";
import { useHermesChat, type HermesStatus } from "../../stores/hermes-chat";
import { useProviderPreferences } from "../settings/provider-preferences";
import { AttachmentPreviewRow } from "./attachments/AttachmentPreviewRow";
import { appendHermesAttachmentPaths } from "./attachments/local-attachment-controller";
import { useConversationAttachments } from "./attachments/use-conversation-attachments";
import { ChatStarterCards } from "./ChatStarterCards";
import { chatSendFailureMessage } from "./chat-send-error";
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

export function HermesPane({ active = true }: { active?: boolean } = {}) {
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
  const setDefaultProvider = useProviderPreferences((state) => state.setDefaultProvider);
  const composerSelections = useProviderPreferences((state) => state.composerSelections);
  const setComposerSelection = useProviderPreferences((state) => state.setComposerSelection);
  const [draft, setDraft] = useState("");
  const [referenceTokens, setReferenceTokens] = useState<ComposerReferenceToken[]>([]);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachments = useConversationAttachments(sessionId);
  const projects = useBoard((state) => state.projects);
  const fallbackCatalog = useMemo(
    () => createLegacyGlobalProviderCatalog({ hasProject: projects.length > 0 }),
    [projects.length],
  );
  const canonicalProviderCatalog = useChatProviderCatalog(fallbackCatalog, { active }).catalog;
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

  useEffect(() => {
    setSubmissionError(null);
  }, [sessionId]);

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
      || !canSubmitChatDraft(
        draft,
        status,
        attachments.items.length,
        contextPreventsSend,
        referenceTokens.length,
      )
    ) return;
    if (attachments.items.length > 0 && !supportsNativeAttachments) {
      setSubmissionError(chatSendFailureMessage(
        "The selected provider does not support file attachments.",
      ));
      return;
    }
    setSubmissionError(null);
    setUploadingAttachments(true);
    try {
      const uploaded = await attachments.uploadAll();
      if (!uploaded.ok) {
        setSubmissionError(chatSendFailureMessage(uploaded.error));
        return;
      }
      const sent = send(appendHermesAttachmentPaths(submission.agentPrompt, uploaded.paths));
      if (!sent) {
        setSubmissionError(chatSendFailureMessage(
          "Can't reach Matrix OS. Check your connection.",
        ));
        return;
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
          onNewChat={() => {
            setSubmissionError(null);
            newChat();
          }}
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

  const visibleError = submissionError ?? loadError;
  const errorBanner = visibleError ? (
    <div role="alert" className={cn("mx-auto mt-3 w-[calc(100%-2.5rem)] rounded-lg border px-3 py-2 text-sm", CHAT_CONTENT_WIDTH_CLASS)} style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>
      {visibleError}
    </div>
  ) : null;

  return (
    <SharedChatSurface
      ariaLabel="Hermes conversation"
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
      {...attachments.paneProps}
    >
      {errorBanner}
      {empty ? (
        <div data-testid="chat-empty-content" className={cn("mx-auto flex min-h-0 w-full flex-1 flex-col justify-center gap-[26px] px-5 py-8", CHAT_CONTENT_WIDTH_CLASS)}>
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
          <ConversationTranscript turns={turns} callbacks={{ copyText, openFile: openFileInDesktopEditor }} />
          <div className={cn("mx-auto w-full shrink-0 px-5 pb-5", CHAT_CONTENT_WIDTH_CLASS)}>
            {renderComposer("Reply to Hermes…")}
          </div>
        </>
      )}
    </SharedChatSurface>
  );
}

function LegacyChatTab({ active }: { active: boolean }) {
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
      {conversationView === "index" ? <HermesConversationIndex api={api} /> : <HermesPane active={active} />}
    </div>
  );
}

export function ChatUnavailableState({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center px-6 text-center"
    >
      <h2 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>
        Chat unavailable
      </h2>
      <p className="mt-1 max-w-sm text-sm" style={{ color: "var(--text-secondary)" }}>
        Reconnect to this computer, then try again.
      </p>
      <Button variant="subtle" className="mt-4" onClick={onRetry}>
        Retry Chat
      </Button>
    </div>
  );
}

export default function ChatTab({
  active = true,
  visible = active,
  tabId,
  initialChatId,
  initialView,
  externalNavigation = false,
  renderInspector,
  inspectorExclusive = false,
  allowLegacyFallback = true,
  eventSource,
}: {
  active?: boolean;
  visible?: boolean;
  tabId?: string;
  initialChatId?: string;
  initialView?: "index" | "draft" | "conversation";
  externalNavigation?: boolean;
  renderInspector?: (detail: CanonicalChatDetailResponse) => ReactNode;
  inspectorExclusive?: boolean;
  allowLegacyFallback?: boolean;
  eventSource?: Pick<CanonicalChatEventSource, "subscribe">;
}) {
  const api = useConnection((state) => state.api);
  const [routeAttempt, setRouteAttempt] = useState(0);
  return (
    <CanonicalChatRoute
      key={routeAttempt}
      api={api}
      projectId={null}
      tabId={tabId}
      initialChatId={initialChatId}
      initialView={initialView}
      active={active}
      live={visible}
      eventSource={eventSource}
      externalNavigation={externalNavigation}
      renderInspector={renderInspector}
      inspectorExclusive={inspectorExclusive}
      fallback={allowLegacyFallback
        ? <LegacyChatTab active={active} />
        : <ChatUnavailableState onRetry={() => setRouteAttempt((attempt) => attempt + 1)} />}
    />
  );
}
