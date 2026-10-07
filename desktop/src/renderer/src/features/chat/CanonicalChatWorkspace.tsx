import { openChatProviderSettings } from "./open-chat-provider-settings";
import { DESKTOP_Z_INDEX } from "../../design/layering";
import { projectContext } from "./canonical-project-context";
import { useBotDraftNavigation } from "./use-bot-draft-navigation";
import { CanonicalChatIdentityGate } from "./CanonicalChatIdentityGate";
import { CanonicalNewChatContent } from "./CanonicalNewChatContent";
import { desktopProviderIdentityKey } from "../../lib/provider-settings-identity";
import { canonicalComposerSelectionIsAvailable } from "./canonical-composer-state";
import {
  isChatUnread,
  chatReadAction,
  CanonicalSharedChatPanel,
  BotChatPanel, BotModelRecoveryProvider,
  BotComposerControls,
  useDirectBotBinding, useBotExecution, botSubmissionParts,
  BotDraftRecoveryPanel,
  SharedChatPanel,
  sharedChatMembershipFromProjection,
} from "@matrix-os/ui";
import type { ChatAgentDraftRequest } from "@matrix-os/ui";
import { createChatMentionRequestTracker } from "@matrix-os/ui";
import { ChatMentionControls, useChatMentionPermission } from "@matrix-os/ui";
import { BotDetailsContext, BotHeaderBindingContext, BotHeaderContext, useSurfaceChromeHost } from "../desktop-shell/SurfaceChrome";
import { ChatSharingButton } from "./ChatSharingButton";
import { ChatContextMenu } from "@matrix-os/ui";
import { openChatWebLink } from "./chat-web-navigation";
import type {
  CanonicalChatClient,
  CanonicalChatEventConnectionState,
  CanonicalChatEventSource,
  CanonicalChatInvalidation,
} from "../../lib/canonical-chat-client";
import type {
  AgentProviderSummary,
  CanonicalChatMessagePart,
  CanonicalChatDetailResponse,
  CanonicalProviderCatalog,
  CanonicalChatQueuedTurn,
} from "@matrix-os/contracts";
import { Plus, Search } from "@renderer/lib/hugeicons";
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { ConversationTranscript } from "../../components/conversation/transcript";
import { CHAT_CONTENT_WIDTH_CLASS } from "../../components/conversation/layout";
import { cn } from "../../lib/cn";
import type { ConversationActionPresentation } from "../../components/conversation/presentation";
import { normalizeDesktopEditorPath } from "../editor/desktop-editor-store";
import { useChatFileNavigation } from "../work/ChatFileNavigation";
import { resolveChatInspectorTargetForRun, resolveWorkFilesScope } from "../work/work-files-scope";
import type { ApiClient } from "../../lib/api";
import { useBoard } from "../../stores/board";
import { useConnection } from "../../stores/connection";
import { createDesktopCollaborationApi } from "../../lib/collaboration";
import { useCodingAgentWorkspace } from "../../stores/coding-agent-workspace";
import { captureRuntimeGeneration, isCurrentRuntimeGeneration } from "../../stores/runtime-generation";
import { AttachmentPreviewRow } from "./attachments/AttachmentPreviewRow";
import { useConversationAttachments } from "./attachments/use-conversation-attachments";
import { CanonicalChatIndex } from "./CanonicalChatIndex";
import { DeleteConversationDialog } from "./DeleteConversationDialog";
import { canonicalChatPresentation } from "./canonical-chat-presentation";
import { canonicalChatInputParts, canonicalChatTitle } from "./canonical-chat-submission";
import { createLegacyGlobalProviderCatalog } from "./canonical-composer-adapter";
import { chatSendFailureMessage } from "./chat-send-error";
import { useChatProviderCatalog } from "./chat-provider-catalog";
import { searchGlobalChatResources } from "./chat-resource-search";
import ConversationContextPicker from "./ConversationContextPicker";
import {
  SharedChatComposer,
  supportsNativeFileAttachments,
  type SharedChatComposerSubmission,
} from "./SharedChatComposer";
import { SharedChatSurface } from "./SharedChatSurface";
import { QueuedTurnsPanel, type QueuedTurnAction } from "./QueuedTurnsPanel";
import { useCanonicalChatRouteController } from "./use-canonical-chat-route-controller";
import { useCanonicalComposerSelection } from "./use-canonical-composer-selection";
import { useProviderSetup } from "./use-provider-setup";
import { useCreateAppRequest } from "../../stores/create-app-request";
import { desktopComposerDraftIdentity, useChatComposerDrafts } from "./use-chat-composer-drafts";
import { useChatAgentDraftRequest } from "./use-chat-agent-draft-request";
import { QueuedTurnEditContext } from "./QueuedTurnEditContext";
import { useImportedChatAssets } from "./use-imported-chat-assets";
import { useChatArtifactActions } from "./use-chat-artifact-actions";
import { useChatCredentialDisclosure } from "./use-chat-credential-disclosure";
import { ChatCredentialDisclosure } from "./ChatCredentialDisclosure";

const EMPTY_PROVIDER_SUMMARIES: AgentProviderSummary[] = [];


// react-doctor-disable-next-line react-doctor/no-high-complexity-react-function -- The pre-existing workspace coordinates the canonical Chat controller, composer, credential disclosure and shared routes; this change only removes live-share callbacks. Splitting it belongs in a focused refactor.
export function CanonicalChatWorkspace({
  api,
  client,
  projectId,
  initialChatId,
  initialView,
  sharedScopeId,
  sharedHeaderContainer,
  onSharedChatMetadata,
  draftRequest,
  onDraftConsumed,
  projectLabel,
  active,
  live = active,
  externalNavigation = false,
  catalog,
  inspector,
  renderInspector,
  inspectorExclusive = false,
  onProjectChanged,
  onActiveChatChanged,
  eventSource,
}: {
  api?: ApiClient;
  client: CanonicalChatClient;
  projectId: string | null;
  initialChatId?: string;
  initialView?: "index" | "draft" | "conversation";
  sharedScopeId?: string;
  sharedHeaderContainer?: HTMLElement | null;
  onSharedChatMetadata?: (metadata: { title: string; role: "owner" | "editor" | "viewer" }) => void;
  draftRequest?: ChatAgentDraftRequest | null;
  onDraftConsumed?: (id: number) => void;
  projectLabel?: string;
  active: boolean;
  live?: boolean;
  externalNavigation?: boolean;
  catalog?: CanonicalProviderCatalog;
  inspector?: ReactNode;
  renderInspector?: (detail: CanonicalChatDetailResponse) => ReactNode;
  inspectorExclusive?: boolean;
  onProjectChanged?: (chatId: string, projectId: string | null, title: string) => void;
  onActiveChatChanged?: (chatId: string | null, title?: string) => void;
  eventSource?: Pick<CanonicalChatEventSource, "subscribe">;
}) {
  const actorId = useConnection((state) => state.userId);
  const authStatus = useConnection((state) => state.status);
  const authGeneration = useConnection((state) => state.authGeneration);
  const platformHost = useConnection((state) => state.platformHost);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const subscribeConnection = useCallback((notify: () => void) => {
    const source = eventSource as Partial<CanonicalChatEventSource> | undefined;
    const subscription = source?.subscribeConnectionState?.(notify);
    return () => subscription?.dispose();
  }, [eventSource]);
  const getConnection = useCallback((): CanonicalChatEventConnectionState => (
    (eventSource as Partial<CanonicalChatEventSource> | undefined)?.connectionState?.() ?? "idle"
  ), [eventSource]);
  const chatConnection = useSyncExternalStore(subscribeConnection, getConnection, getConnection);
  const [credentialSuspendedChatId, setCredentialSuspendedChatId] = useState<string | null>(null);
  const explicitSharedRoute = Boolean(sharedScopeId);
  const collaborationApi = useMemo(
    () => createDesktopCollaborationApi(platformHost),
    [platformHost],
  );
  const [mentionRequests] = useState(createChatMentionRequestTracker);
  const projects = useBoard((state) => state.projects);
  const fileNavigation = useChatFileNavigation();
  const chromeHost = useSurfaceChromeHost();
  const botHeaderContainer = useContext(BotHeaderContext);
  const frameDetailsContainer = useContext(BotDetailsContext);
  const reportBotHeaderBinding = useContext(BotHeaderBindingContext);
  const [botDetailsContainer, setBotDetailsContainer] = useState<HTMLElement | null>(null);
  const fallbackCatalog = useMemo(
    () => createLegacyGlobalProviderCatalog({ hasProject: projects.length > 0 }),
    [projects.length],
  );
  const liveCatalog = useChatProviderCatalog(fallbackCatalog, {
    api: api ?? null,
    active: live && !explicitSharedRoute,
  });
  const providerCatalog = catalog ?? liveCatalog.catalog;
  const providerCatalogLoading = !catalog && liveCatalog.initialLoading;
  const onCredentialInvalidation = useCallback((event: CanonicalChatInvalidation) => {
    if (event.type !== "chat.changed"
      || (event.eventType !== "chat.updated" && event.eventType !== "chat.deleted")) return;
    // A share conversion changes the Chat row. Flush plaintext before the
    // controller starts its potentially delayed canonical detail refresh.
    flushSync(() => setCredentialSuspendedChatId(event.chatId));
    if (event.eventType === "chat.deleted") return;
    void client.getDetail(event.chatId, { limit: 1 }).then((fresh) => {
      if (fresh.record.chat.collaboration || fresh.record.chat.lifecycle !== "active") return;
      setCredentialSuspendedChatId((current) => current === event.chatId ? null : current);
    }).catch(() => {
      // Keep disclosure suspended until a fresh private-owner read succeeds.
    });
  }, [client]);
  const controller = useCanonicalChatRouteController({
    client,
    projectId,
    active: live && !explicitSharedRoute,
    initialChatId,
    autoSelectFirst: false,
    eventSource,
    onInvalidation: onCredentialInvalidation,
  });
  const [botEventRevision, setBotEventRevision] = useState(0);
  useEffect(() => {
    if (!live || !eventSource) return;
    const subscription = eventSource.subscribe((event) => {
      if (event.type === "chat.changed" && event.chatId === controller.activeChatId
        && /^(?:interaction\.|bot\.)/.test(event.eventType)) {
        setBotEventRevision((revision) => revision + 1);
      }
    });
    return () => subscription.dispose();
  }, [live, eventSource, controller.activeChatId]);
  const [globalView, setGlobalView] = useState<"index" | "draft" | "conversation">(
    initialView ?? (initialChatId ? "conversation" : "index"),
  );
  const routedComposerChatId = externalNavigation
    ? initialChatId ?? controller.activeChatId
    : controller.activeChatId ?? initialChatId;
  const draftRetentionIdentity = useConnection(state => state.status === "signed-in" && state.userId
    ? desktopComposerDraftIdentity(state) : undefined);
  const {
    text: draft,
    revision: draftRevision,
    updateIfUnchanged: updateDraftIfUnchanged,
    referenceTokens,
    requestIdentity: draftRequestIdentity,
    draftProjectId,
    setText: setDraft,
    setReferenceTokens,
    setDraftProjectId,
    prepareNewChatDraft,
    removeChatDraft,
    seedChatDraft,
  } = useChatComposerDrafts({
    clientIdentity: client,
    retentionIdentity: draftRetentionIdentity,
    chatId: routedComposerChatId,
    projectId,
    conversation: globalView === "conversation",
  });
  const draftScope = globalView === "conversation" && routedComposerChatId
    ? `chat:${routedComposerChatId}` : `new:${projectId ?? "global"}`;
  const composerOwner = useRef({ client, draftScope, draftRevision, identity: desktopProviderIdentityKey(useConnection.getState()) });
  useLayoutEffect(() => {
    composerOwner.current = { client, draftScope, draftRevision, identity: desktopProviderIdentityKey(useConnection.getState()) };
  });
  const mentionResources = referenceTokens.flatMap((token) => token.type === "resource" ? [token.resource] : []);
  const [query, setQuery] = useState("");
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const [composerAction, setComposerAction] = useState<"queue" | "edit" | null>(null);
  const [queuePendingAction, setQueuePendingAction] = useState<{
    queuedTurnId: string;
    action: QueuedTurnAction;
  } | null>(null);
  const [optimisticQueuedTurns, setOptimisticQueuedTurns] = useState<CanonicalChatQueuedTurn[] | null>(null);
  const [editingQueuedTurn, setEditingQueuedTurn] = useState<CanonicalChatQueuedTurn | null>(null);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [localComposerFocusRequestId, setLocalComposerFocusRequestId] = useState(0);
  const previousRoute = useRef({ initialChatId, initialView, projectId });
  const reportedChatId = useRef<string | null>(initialChatId ?? null);
  const submissionSequence = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachments = useConversationAttachments(controller.activeChatId, api ?? null);
  useChatAgentDraftRequest({ request: draftRequest, eligible: active && !initialChatId && initialView !== "conversation" && !explicitSharedRoute,
    prepare: prepareNewChatDraft, showDraft: () => setGlobalView("draft"),
    focus: () => setLocalComposerFocusRequestId((requestId) => requestId + 1), onConsumed: onDraftConsumed });
  const runtimeSummary = useCodingAgentWorkspace((state) => state.summary);
  const runtimeStatus = useCodingAgentWorkspace((state) => state.status);
  const composerFocusRequestId = useCodingAgentWorkspace((state) => state.composerFocusRequestId);
  const refreshRuntimeSummary = useCodingAgentWorkspace((state) => state.refresh);
  const handleProviderSetup = useProviderSetup(
    runtimeSummary?.providers ?? EMPTY_PROVIDER_SUMMARIES,
    refreshRuntimeSummary,
    api ?? null,
  );
  const { selection: providerSelection, onSelectionChange } = useCanonicalComposerSelection({
    catalog: providerCatalog,
    catalogReady: Boolean(catalog || liveCatalog.lastSuccessAt !== null || liveCatalog.status === "error"),
    initializeImmediately: Boolean(catalog),
    chatId: controller.detail?.record.chat.id ?? null,
    currentSelection: controller.detail?.record.chat.currentSelection,
    boundInstanceId: controller.detail?.record.providerBinding?.instanceId,
  });
  const botBinding = useDirectBotBinding(explicitSharedRoute ? undefined : routedComposerChatId ?? undefined, client.agents);
  const directBotId = botBinding.agentId;
  useEffect(() => {
    if (explicitSharedRoute || !routedComposerChatId || !reportBotHeaderBinding) return;
    return reportBotHeaderBinding({ chatId: routedComposerChatId, client, status: botBinding.status, agentId: directBotId });
  }, [explicitSharedRoute, routedComposerChatId, client, reportBotHeaderBinding, botBinding.status, directBotId]);
  const botExecution = useBotExecution(directBotId, client.agents, providerCatalog, botEventRevision);
  const botIdentityUnknown = botBinding.status === "loading" || botBinding.status === "error" || botExecution.loading || Boolean(botExecution.error);
  const botPresentation = botExecution.presentation;
  const selection = botIdentityUnknown ? null : directBotId ? botPresentation ? { ...botPresentation.selection, options: botPresentation.selection.options ?? [], interactionMode: botPresentation.interactionMode, permissionMode: botPresentation.permissionMode } : null : providerSelection;
  const botRouteAvailable = !botIdentityUnknown && (directBotId ? Boolean(botPresentation?.available) : canonicalComposerSelectionIsAvailable(providerCatalog, selection));
  const permissionResources = directBotId ? botExecution.consentResources : mentionResources;
  const mentionPermission = useChatMentionPermission(routedComposerChatId ?? `new:${projectId ?? "global"}`, permissionResources,
    selection?.permissionMode ?? "supervised", draftRequestIdentity);
  const selectionAvailable = botRouteAvailable && (!botPresentation?.requiresFullAccess || mentionPermission.confirmed);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const [workspaceLayout, setWorkspaceLayout] = useState<"wide" | "narrow">("wide");
  const createAppRequest = useCreateAppRequest((state) => state.request);
  const clearCreateAppRequest = useCreateAppRequest((state) => state.clear);

  useEffect(() => {
    if (!active || !createAppRequest) return;
    prepareNewChatDraft({ text: createAppRequest.prompt });
    setGlobalView("draft");
    clearCreateAppRequest(createAppRequest.id);
  }, [active, clearCreateAppRequest, createAppRequest, prepareNewChatDraft]);

  useLayoutEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (typeof width !== "number") return;
      setWorkspaceLayout(width < 720 ? "narrow" : "wide");
    });
    observer.observe(workspace);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!api || explicitSharedRoute || runtimeStatus !== "idle") return;
    void refreshRuntimeSummary();
  }, [api, explicitSharedRoute, refreshRuntimeSummary, runtimeStatus]);

  useLayoutEffect(() => {
    const previous = previousRoute.current;
    if (
      previous.initialChatId === initialChatId
      && previous.initialView === initialView
      && previous.projectId === projectId
    ) return;
    previousRoute.current = { initialChatId, initialView, projectId };
    if (initialView === "draft") reportedChatId.current = initialChatId ?? null;
    setGlobalView(initialView ?? (initialChatId ? "conversation" : "index"));
  }, [initialChatId, initialView, projectId]);

  useLayoutEffect(() => {
    submissionSequence.current += 1;
    setUploadingAttachments(false);
    setComposerAction(null);
    setQueuePendingAction(null);
    setOptimisticQueuedTurns(null);
    setEditingQueuedTurn(null);
    setSubmissionError(null);
  }, [client]);

  useEffect(() => {
    setOptimisticQueuedTurns(null);
  }, [controller.activeChatId]);

  useEffect(() => {
    const record = controller.detail?.record;
    const routedChatId = initialChatId ?? controller.activeChatId;
    // A parent-owned draft route can arrive one effect before the previous
    // detail is cleared. Only explicit draft actions may promote a Chat, and
    // a conversation route may only report the detail for its routed Chat.
    if (initialView === "draft"
      || !record
      || record.chat.id !== routedChatId
      || reportedChatId.current === record.chat.id) return;
    reportedChatId.current = record.chat.id;
    onActiveChatChanged?.(record.chat.id, record.chat.title);
  }, [controller.activeChatId, controller.detail?.record, initialChatId, initialView, onActiveChatChanged]);

  const composerProjectId = controller.detail ? controller.detail.record.projectId ?? null : draftProjectId;
  const context = projectContext(
    composerProjectId ?? undefined,
    projects,
    projectLabel,
  );
  const activeRun = controller.detail?.record.activeRun;
  const activeRunRecord = activeRun
    ? controller.detail?.runs.find((run) => run.id === activeRun.runId)
    : undefined;
  const canSteerActiveRun = activeRunRecord?.capabilitySnapshot.steering === "same_run";
  const serverQueuedTurns = controller.detail?.queuedTurns ?? [];
  const queuedTurns = optimisticQueuedTurns ?? serverQueuedTurns;
  const composerHasInput = Boolean(
    draft.trim() || referenceTokens.length > 0 || attachments.items.length > 0,
  );
  const transcript = controller.detail ? canonicalChatPresentation({
    ...controller.detail,
    streamedMessageIds: controller.streamedMessageIds,
  }) : [];
  const projectedSharedChat = sharedChatMembershipFromProjection(controller.detail?.record.chat.collaboration);
  const privateOwner = controller.detail?.record.chat.ownerScope;
  const credentialScopeKey = active && live && api && authStatus === "signed-in" && actorId
    && privateOwner?.type === "personal" && privateOwner.ownerId === actorId
    && !sharedScopeId && !projectedSharedChat && chatConnection === "open"
    && credentialSuspendedChatId !== controller.detail?.record.chat.id
    && controller.detail?.record.chat.lifecycle === "active"
    ? `${actorId}\u0000${authGeneration}\u0000${runtimeSlot}\u0000${controller.detail.record.chat.id}` : null;
  const credentialDisclosure = useChatCredentialDisclosure({ client, detail: controller.detail, scopeKey: credentialScopeKey });
  const artifactActions = useChatArtifactActions(api, controller.detail, projects);
  const importedAssets = useImportedChatAssets(api, controller.detail?.record.chat.id);

  useEffect(() => {
    if (!editingQueuedTurn || !controller.detail) return;
    const editStillExists = controller.detail.record.chat.id === editingQueuedTurn.chatId
      && queuedTurns.some((turn) => turn.id === editingQueuedTurn.id);
    if (!editStillExists) setEditingQueuedTurn(null);
  }, [controller.detail, editingQueuedTurn, queuedTurns]);
  const loadChatImage = useCallback((src: string) => {
    if (!api) return Promise.reject(new Error("ChatUnavailable"));
    if (/^\/api\/chats\/[^/]+\/imports\/assets\//.test(src)) return importedAssets.loadImportedImage(src);
    return api.getBlob(src, { maxBytes: 8 * 1024 * 1024 });
  }, [api, importedAssets.loadImportedImage]);
  const copyText = useCallback(async (text: string) => {
    if (!navigator.clipboard?.writeText) throw new Error("ClipboardUnavailable");
    await navigator.clipboard.writeText(text);
  }, []);
  const retryTurn = controller.retryTurn;
  const submitApproval = controller.submitApproval;
  const performTranscriptAction = useCallback(async (action: ConversationActionPresentation) => {
    if (action.kind === "retry") {
      const admitted = await retryTurn(action.turnId);
      if (!admitted) throw new Error("RetryUnavailable");
      return;
    }
    if (action.kind === "approval") {
      const submitted = await submitApproval(action.requestId, action.decision);
      if (!submitted) throw new Error("ApprovalUnavailable");
      return;
    }
    throw new Error("UnsupportedConversationAction");
  }, [retryTurn, submitApproval]);
  const canPerformTranscriptAction = useCallback((action: ConversationActionPresentation) => (
    action.kind === "retry" || action.kind === "approval"
  ), []);
  const activeProjectSlug = projects.find((project) => (
    project.id === composerProjectId || project.slug === composerProjectId
  ))?.slug;
  const resourceSearch = useCallback(async (resourceQuery: string) => {
    const results = await Promise.allSettled([
      api ? searchGlobalChatResources(api, activeProjectSlug ?? null, resourceQuery) : Promise.resolve([]),
      client.agents?.search(resourceQuery, routedComposerChatId ?? undefined).then((result) => result.enabled ? result.resources : []) ?? Promise.resolve([]),
    ]);
    return results.flatMap((result) => {
      if (result.status === "fulfilled") return result.value.filter((resource) => (
        !editingQueuedTurn || (resource.kind !== "agent" && resource.kind !== "chat")
      ));
      console.warn("[chat] Resource search unavailable");
      return [];
    });
  }, [activeProjectSlug, api, client.agents, routedComposerChatId, editingQueuedTurn]);
  const resources = projects.map((project) => ({
    kind: "project" as const,
    id: project.id ?? project.slug,
    label: project.name,
  }));

  const moveProject = async (targetProjectId: string | null) => {
    const runtimeGeneration = captureRuntimeGeneration();
    const moved = await controller.moveProject(targetProjectId);
    if (
      moved
      && isCurrentRuntimeGeneration(runtimeGeneration)
      && targetProjectId !== projectId
    ) onProjectChanged?.(moved.chat.id, targetProjectId, moved.chat.title);
  };

  const resolveSubmissionParts = async (
    submission: SharedChatComposerSubmission,
    isCurrentSubmission: () => boolean,
  ): Promise<CanonicalChatMessagePart[] | null> => {
    const uploaded = await attachments.uploadAll();
    if (!isCurrentSubmission()) return null;
    if (!uploaded.ok) {
      setSubmissionError(chatSendFailureMessage(uploaded.error));
      return null;
    }
    const uploadedParts: CanonicalChatMessagePart[] = uploaded.attachments.flatMap((attachment) => (
      attachment.path
        ? [{
            type: "attachment_reference" as const,
            attachmentId: attachment.id,
            kind: attachment.kind === "image" ? "image" as const : "file" as const,
            label: attachment.label,
            ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
            ...(attachment.sizeBytes !== undefined ? { sizeBytes: attachment.sizeBytes } : {}),
            ownerReference: attachment.path,
          }]
        : []
    ));
    const parts = [...canonicalChatInputParts(submission), ...uploadedParts];
    return parts.length > 0 ? parts : null;
  };

  const submit = async (submission: SharedChatComposerSubmission) => {
    const selectedInstance = providerCatalog.instances.find((instance) => instance.id === selection?.instanceId);
    if (
      !selection
      || (!directBotId && providerCatalogLoading)
      || !selectionAvailable
      || (activeRun && !mentionResources.length)
      || uploadingAttachments
    ) return;
    if (attachments.items.length > 0 && !supportsNativeFileAttachments(selectedInstance)) {
      setSubmissionError(chatSendFailureMessage(
        "The selected provider does not support file attachments.",
      ));
      return;
    }
    setSubmissionError(null);
    const runtimeGeneration = captureRuntimeGeneration();
    const providerCatalogGeneration = useConnection.getState().providerCatalogGeneration;
    const sequence = ++submissionSequence.current;
    const owner = composerOwner.current;
    const isCurrentOwner = () => (
      sequence === submissionSequence.current
      && isCurrentRuntimeGeneration(runtimeGeneration)
      && composerOwner.current.client === owner.client
      && composerOwner.current.draftScope === owner.draftScope
      && desktopProviderIdentityKey(useConnection.getState()) === owner.identity
    );
    const isCurrentSubmission = () => isCurrentOwner()
      && composerOwner.current.draftRevision === draftRevision
      && useConnection.getState().providerCatalogGeneration === providerCatalogGeneration;
    const submittedAttachmentIds = attachments.items.map((item) => item.localId);
    setUploadingAttachments(true);
    try {
      const parts = await resolveSubmissionParts(submission, isCurrentSubmission);
      if (!parts) return;
      const input = {
        parts: directBotId ? botSubmissionParts(parts, botExecution.consentResources) : parts,
        selection: {
          instanceId: selection.instanceId,
          model: selection.model,
          ...(selection.options.length > 0 ? { options: selection.options } : {}),
        },
        interactionMode: selection.interactionMode,
        permissionMode: mentionPermission.permissionMode,
      };
      const requestScope = routedComposerChatId ?? `new:${projectId ?? "global"}`;
      const attempt = permissionResources.length ? mentionRequests.resolve(client, requestScope, input, "send") : undefined;
      const clientRequestId = attempt?.clientRequestId;
      const acknowledgeAccepted = () => {
        if (!isCurrentRuntimeGeneration(runtimeGeneration)
          || composerOwner.current.client !== owner.client
          || desktopProviderIdentityKey(useConnection.getState()) !== owner.identity) return;
        if (clientRequestId) mentionRequests.accepted(requestScope, clientRequestId);
        mentionPermission.confirm(false);
        updateDraftIfUnchanged(draftRevision, { text: "", referenceTokens: [] });
        for (const id of submittedAttachmentIds) attachments.remove(id);
      };
      const admitted = attempt?.operation === "queue"
        ? await controller.queueTurn({ ...input, clientRequestId }, acknowledgeAccepted)
        : await controller.submitTurn({ ...input, clientRequestId }, canonicalChatTitle(submission), draftProjectId, acknowledgeAccepted);
      if (!admitted || !isCurrentOwner()) return;
      if ("record" in admitted) {
        reportedChatId.current = admitted.record.chat.id;
        const admittedProjectId = admitted.record.projectId ?? null;
        if (admittedProjectId !== projectId && onProjectChanged) {
          onProjectChanged(admitted.record.chat.id, admittedProjectId, admitted.record.chat.title);
        } else {
          onActiveChatChanged?.(admitted.record.chat.id, admitted.record.chat.title);
        }
        setGlobalView("conversation");
        setDraftProjectId(admittedProjectId);
      }
    } finally {
      if (sequence === submissionSequence.current) setUploadingAttachments(false);
    }
  };

  const submitQueueAction = async (submission: SharedChatComposerSubmission) => {
    const selectedInstance = providerCatalog.instances.find((instance) => instance.id === selection?.instanceId);
    if (
      (!activeRun && !editingQueuedTurn && !mentionResources.length)
      || !controller.detail
      || !selection
      || (!directBotId && providerCatalogLoading)
      || !selectionAvailable
      || composerAction
      || uploadingAttachments
      || (attachments.items.length > 0 && !supportsNativeFileAttachments(selectedInstance))
    ) return;
    const runtimeGeneration = captureRuntimeGeneration();
    const providerCatalogGeneration = useConnection.getState().providerCatalogGeneration;
    const sequence = ++submissionSequence.current;
    const owner = composerOwner.current;
    const isCurrentOwner = () => (
      sequence === submissionSequence.current
      && isCurrentRuntimeGeneration(runtimeGeneration)
      && composerOwner.current.client === owner.client
      && composerOwner.current.draftScope === owner.draftScope
      && desktopProviderIdentityKey(useConnection.getState()) === owner.identity
    );
    const isCurrentSubmission = () => isCurrentOwner()
      && composerOwner.current.draftRevision === draftRevision
      && useConnection.getState().providerCatalogGeneration === providerCatalogGeneration;
    const submittedAttachmentIds = attachments.items.map((item) => item.localId);
    setComposerAction(editingQueuedTurn ? "edit" : "queue");
    setUploadingAttachments(true);
    try {
      const parts = await resolveSubmissionParts(submission, isCurrentSubmission);
      if (!parts) return;
      const updatedParts = editingQueuedTurn
        ? [
            ...editingQueuedTurn.parts.filter((part) => part.type !== "text"),
            ...parts,
          ]
        : parts;
      const input = {
        parts: directBotId ? botSubmissionParts(updatedParts, botExecution.consentResources) : updatedParts,
        selection: { instanceId: selection.instanceId, model: selection.model, ...(selection.options.length ? { options: selection.options } : {}) },
        interactionMode: selection.interactionMode, permissionMode: mentionPermission.permissionMode,
      };
      const requestScope = routedComposerChatId ?? `new:${projectId ?? "global"}`;
      const attempt = permissionResources.length ? mentionRequests.resolve(client, requestScope, input, "queue") : undefined;
      const clientRequestId = attempt?.clientRequestId;
      const acknowledgeAccepted = () => {
        if (!isCurrentRuntimeGeneration(runtimeGeneration)
          || composerOwner.current.client !== owner.client
          || desktopProviderIdentityKey(useConnection.getState()) !== owner.identity) return;
        if (clientRequestId) mentionRequests.accepted(requestScope, clientRequestId);
        mentionPermission.confirm(false);
        updateDraftIfUnchanged(draftRevision, { text: "", referenceTokens: [] });
        for (const id of submittedAttachmentIds) attachments.remove(id);
      };
      const response = editingQueuedTurn
        ? await controller.updateQueuedTurn(editingQueuedTurn.id, updatedParts, acknowledgeAccepted)
        : attempt?.operation === "send"
          ? await controller.submitTurn({ ...input, clientRequestId }, canonicalChatTitle(submission), draftProjectId ?? projectId, acknowledgeAccepted)
          : await controller.queueTurn({ ...input, clientRequestId }, acknowledgeAccepted);
      if (!isCurrentOwner()) return;
      if (!response) return;
      setEditingQueuedTurn(null);
    } finally {
      if (sequence === submissionSequence.current) {
        setComposerAction(null);
        setUploadingAttachments(false);
      }
    }
  };

  const reorderQueuedTurns = async (queuedTurnIds: string[], movedQueuedTurnId: string) => {
    if (queuePendingAction || editingQueuedTurn) return;
    const ordered = [...queuedTurns].sort((left, right) => left.position - right.position);
    if (queuedTurnIds.length !== ordered.length
      || queuedTurnIds.some((queuedTurnId) => !ordered.some((turn) => turn.id === queuedTurnId))) return;
    const byId = new Map(ordered.map((turn) => [turn.id, turn]));
    setOptimisticQueuedTurns(queuedTurnIds.map((queuedTurnId, index) => ({
      ...byId.get(queuedTurnId)!,
      position: index + 1,
    })));
    setQueuePendingAction({ queuedTurnId: movedQueuedTurnId, action: "move" });
    try {
      await controller.reorderQueuedTurns(queuedTurnIds);
    } finally {
      setOptimisticQueuedTurns(null);
      setQueuePendingAction(null);
    }
  };

  const cancelQueuedTurn = async (queuedTurnId: string) => {
    if (queuePendingAction || editingQueuedTurn) return;
    setQueuePendingAction({ queuedTurnId, action: "cancel" });
    try {
      await controller.cancelQueuedTurn(queuedTurnId);
    } finally {
      setQueuePendingAction(null);
    }
  };

  const steerQueuedTurn = async (queuedTurnId: string) => {
    if (botIdentityUnknown || queuePendingAction || editingQueuedTurn || !canSteerActiveRun || !activeRun) return;
    const queuedTurn = serverQueuedTurns.find((turn) => turn.id === queuedTurnId);
    if (!queuedTurn) return;
    setQueuePendingAction({ queuedTurnId, action: "steer" });
    try {
      await controller.steerQueuedTurn(queuedTurnId);
    } finally {
      setQueuePendingAction(null);
    }
  };

  const editQueuedTurn = (queuedTurnId: string) => {
    if (botIdentityUnknown || queuePendingAction || composerAction || uploadingAttachments || composerHasInput) return;
    const queuedTurn = queuedTurns.find((turn) => turn.id === queuedTurnId);
    if (!queuedTurn) return;
    const text = queuedTurn.parts
      .flatMap((part) => part.type === "text" ? [part.text] : [])
      .join("\n");
    setEditingQueuedTurn(queuedTurn);
    setReferenceTokens([]);
    attachments.clear();
    setDraft(text);
  };

  const startNewChat = () => {
    setEditingQueuedTurn(null);
    setOptimisticQueuedTurns(null);
    setSubmissionError(null);
    controller.startNewChat();
    reportedChatId.current = null;
    onActiveChatChanged?.(null);
    botMention.clearNotice();
    prepareNewChatDraft();
    setGlobalView("draft");
    setLocalComposerFocusRequestId((requestId) => requestId + 1);
  };

  const selectChat = (chatId: string) => {
    setEditingQueuedTurn(null);
    setOptimisticQueuedTurns(null);
    setSubmissionError(null);
    controller.selectChat(chatId);
    const selected = controller.items.find((item) => item.chat.id === chatId);
    reportedChatId.current = chatId;
    onActiveChatChanged?.(chatId, selected?.chat.title);
    setGlobalView("conversation");
  };

  const botMention = useBotDraftNavigation({ client: client.agents, scope: draftScope, revision: draftRevision, chatId: routedComposerChatId, projectId, sourceHasAttachments: attachments.items.length > 0, seed: seedChatDraft, open: selectChat,
    restoreNewDraft: () => { controller.startNewChat(); reportedChatId.current = null; onActiveChatChanged?.(null); setGlobalView("draft"); },
  });

  const composer = (
    <>
      <QueuedTurnsPanel
        turns={queuedTurns}
        disabled={Boolean(editingQueuedTurn) || composerAction !== null || uploadingAttachments}
        canSteer={!botIdentityUnknown && canSteerActiveRun} canEdit={!botIdentityUnknown}
        pendingAction={queuePendingAction}
        editingQueuedTurnId={editingQueuedTurn?.id ?? null}
        onSteer={(queuedTurnId) => void steerQueuedTurn(queuedTurnId)}
        onEdit={editQueuedTurn}
        onReorder={(queuedTurnIds, movedQueuedTurnId) => void reorderQueuedTurns(queuedTurnIds, movedQueuedTurnId)}
        onCancel={(queuedTurnId) => void cancelQueuedTurn(queuedTurnId)}
      />
      <CanonicalChatIdentityGate unknown={botIdentityUnknown} loading={botBinding.loading} retry={() => { botBinding.retry(); botExecution.retry(); }} onAbort={activeRun ? () => void controller.cancelActiveRun() : undefined}><>
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

      <SharedChatComposer
        value={draft}
        onChange={setDraft}
        draftScopeKey={routedComposerChatId ?? `new:${projectId ?? "global"}`}
        referenceTokens={referenceTokens}
        onReferenceTokensChange={setReferenceTokens}
        onAgentMention={botMention.select}
        onSubmit={(submission) => void (
          editingQueuedTurn || activeRun ? submitQueueAction(submission) : submit(submission)
        )}
        onAbort={activeRun ? () => void controller.cancelActiveRun() : undefined}
        busy={Boolean(activeRun) || uploadingAttachments}
        submitWhileBusy={Boolean(activeRun)}
        disabled={controller.status === "loading" || uploadingAttachments}
        canSubmit={Boolean(selectionAvailable && !uploadingAttachments && (
          draft.trim() || referenceTokens.length > 0 || attachments.items.length > 0
        ))}
        catalog={providerCatalog}
        automaticRouting={botPresentation?.kind === "recipe"}
        botControls={directBotId ? <BotComposerControls key={directBotId} agentId={directBotId} client={client.agents} catalog={providerCatalog} catalogLoading={providerCatalogLoading} onSetup={openChatProviderSettings} onRefreshCatalog={liveCatalog.refresh} zIndex={DESKTOP_Z_INDEX.popover} disabled={uploadingAttachments} refreshKey={botEventRevision} onChanged={() => setBotEventRevision(value => value + 1)}/> : undefined}
        providerCatalogLoading={!directBotId && providerCatalogLoading}
        selection={selection}
        onSelectionChange={onSelectionChange}
        onProviderSetup={(instance, action) => void handleProviderSetup(instance, action)}
        instanceLocked={controller.detail?.record.providerBinding !== undefined}
        resources={resources}
        resourceSearch={resourceSearch}
        onAttach={() => fileInputRef.current?.click()}
        attachments={(
          <AttachmentPreviewRow
            items={attachments.items}
            disabled={uploadingAttachments}
            onRemove={attachments.remove}
            onRetry={(localId) => void attachments.retry(localId)}
          />
        )}
        onNewChat={startNewChat}
        focusRequestId={active ? composerFocusRequestId + localComposerFocusRequestId : 0}
        placeholder={editingQueuedTurn
          ? "Edit queued message…"
          : globalView === "conversation" ? "Reply to chat…" : "How can I help you today?"}
        ariaLabel={globalView === "conversation" ? "Reply to chat" : "Start a chat"}
        leadingControls={(
          <ConversationContextPicker
            context={context}
            compact={!context}
            disabled={Boolean(activeRun)}
            onSelect={(targetProjectSlug) => {
              const target = projects.find((project) => project.slug === targetProjectSlug);
              const targetProjectId = target?.id ?? targetProjectSlug;
              if (controller.detail) {
                void moveProject(targetProjectId);
                return;
              }
              setDraftProjectId(targetProjectId);
            }}
            onRemove={() => {
              if (controller.detail) {
                void moveProject(null);
                return;
              }
              setDraftProjectId(null);
            }}
          />
        )}
        speech={{
          scopeKey: routedComposerChatId ?? `new:${projectId ?? "global"}`,
          onDraft: (text) => setDraft((current) => {
            const trimmed = current.trimEnd();
            return trimmed.length > 0 ? `${trimmed} ${text}` : text;
          }),
        }}
        layout={workspaceLayout === "narrow" ? "narrow" : "default"}
      />
      {editingQueuedTurn ? <QueuedTurnEditContext turn={editingQueuedTurn} /> : null}
      {botMention.pending ? <p role="status" className="px-3 text-xs">Opening bot Chat…</p> : null}
      {botMention.error ? <p role="alert" className="px-3 text-xs">{botMention.error}</p> : null}
      <ChatMentionControls client={client.agents} resources={permissionResources} permissionMode={selection?.permissionMode ?? "supervised"}
        bot={Boolean(directBotId)} requiresFullAccess={botPresentation?.requiresFullAccess} confirmed={mentionPermission.confirmed} onConfirm={mentionPermission.confirm} />
      </></CanonicalChatIdentityGate>
    </>
  );

  const sharingChatId = controller.detail?.record.chat.id;
  const chatSharingAction = api && !chromeHost && sharingChatId ? <ChatSharingButton key={sharingChatId} api={api}
    chatId={sharingChatId} copyText={copyText} /> : null;

  return (
    <BotModelRecoveryProvider agentId={directBotId} client={client.agents} onSetup={openChatProviderSettings} onRefreshCatalog={liveCatalog.refresh}><div
      ref={workspaceRef}
      className={`relative flex min-h-0 min-w-0 flex-1 overflow-hidden ${workspaceLayout === "narrow" ? "flex-col" : "flex-row"}`}
      data-slot="canonical-chat-workspace"
      data-layout={workspaceLayout}
    >
      {!externalNavigation && (projectId === null ? (
        <CanonicalChatIndex
          onToggleRead={(record) => { void controller.updateReadState(record.chat.id, chatReadAction(record)); }}
          items={controller.items}
          activeChatId={controller.activeChatId}
          query={query}
          status={controller.status}
          error={controller.error}
          onQueryChange={setQuery}
          onSearch={(value) => void controller.search(value)}
          onSelect={selectChat}
          onDelete={(record) => {
            setDeleteError(null);
            setDeleteTarget({ id: record.chat.id, title: record.chat.title });
          }}
          onNewChat={startNewChat}
          layout={workspaceLayout}
        />
      ) : <aside
        aria-label="Project chats"
        data-layout={workspaceLayout}
        className={`flex shrink-0 flex-col p-3 ${workspaceLayout === "narrow" ? "h-[168px] min-h-[120px] w-full border-b" : "w-[260px] border-r"}`}
        style={{ borderColor: "var(--border-subtle)", background: "var(--bg-sunken)" }}
      >
        <div className="flex items-center justify-between gap-2 px-1 pb-3">
          <div className="min-w-0">
            <h2 className="truncate text-[14px] font-semibold leading-[20px]" style={{ color: "var(--text-primary)" }}>
              {projectLabel ?? "Project chats"}
            </h2>
            <p className="text-[12px] leading-[16px] tracking-[0.12px]" style={{ color: "var(--text-tertiary)" }}>
              Project
            </p>
          </div>
          <button
            type="button"
            aria-label="New chat"
            className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-[var(--bg-hover)]"
            onClick={startNewChat}
          >
            <Plus size={15} aria-hidden />
          </button>
        </div>
        <form
          className="relative mb-3"
          onSubmit={(event) => {
            event.preventDefault();
            void controller.search(query);
          }}
        >
          <Search size={14} aria-hidden className="absolute left-2.5 top-2.5" style={{ color: "var(--text-tertiary)" }} />
          <input
            value={query}
            aria-label="Search chats"
            placeholder="Search chats"
            className="h-9 w-full rounded-lg border bg-transparent pl-8 pr-2 text-[14px] leading-[20px] outline-none focus:border-[var(--accent)]"
            style={{ borderColor: "var(--border-default)", color: "var(--text-primary)" }}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setQuery(value);
              if (!value) void controller.refresh();
            }}
          />
        </form>
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
          {controller.items.map((record) => (
            <ChatContextMenu key={record.chat.id} chatId={record.chat.id} primaryAction={{ label: isChatUnread(record) ? "Mark as read" : "Mark as unread", onSelect: () => { void controller.updateReadState(record.chat.id, chatReadAction(record)); } }}>
            <button
              type="button"
              aria-label={record.chat.title}
              aria-pressed={record.chat.id === controller.activeChatId}
              className="w-full rounded-lg px-2.5 py-2 text-left hover:bg-[var(--bg-hover)] aria-pressed:bg-[var(--bg-selected)]"
              onClick={() => selectChat(record.chat.id)}
            >
              <span className="block truncate text-[14px] font-medium leading-[20px]" style={{ color: "var(--text-primary)" }}>
                {isChatUnread(record) ? <span aria-label={`Unread ${record.chat.title}`} className="mr-2 inline-block size-2 rounded-full bg-[var(--accent)]" /> : null}
                {record.chat.title}
              </span>
              <span className="block truncate text-[12px] leading-[16px] tracking-[0.12px]" style={{ color: "var(--text-tertiary)" }}>
                {record.chat.lastMessagePreview ?? "No messages yet"}
              </span>
            </button>
            </ChatContextMenu>
          ))}
          {controller.status === "ready" && controller.items.length === 0 ? (
            <p className="px-2 py-3 text-xs" style={{ color: "var(--text-tertiary)" }}>No chats yet.</p>
          ) : null}
        </div>
      </aside>)}
      <SharedChatSurface
        ref={setBotDetailsContainer}
        ariaLabel={projectId ? "Project Chat" : "Global Chat"}
        project={projectId ? { projectId, label: projectLabel ?? projectId } : undefined}
        aria-hidden={inspectorExclusive || undefined}
        inert={inspectorExclusive || undefined}
        hidden={inspectorExclusive}
        className={cn(
          "matrix-bot-chat-layout @container/bot-chat relative min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
          inspectorExclusive ? "hidden" : "flex",
        )}
        {...attachments.paneProps}
      >
        {sharedScopeId || projectedSharedChat ? (
          collaborationApi && actorId ? (
            sharedScopeId ? <SharedChatPanel api={collaborationApi} actorId={actorId}
              runtimeId={`desktop:${runtimeSlot}`} scopeId={sharedScopeId}
              headerContainer={sharedHeaderContainer} onMetadata={onSharedChatMetadata} />
              : <CanonicalSharedChatPanel api={collaborationApi} actorId={actorId}
                runtimeId={`desktop:${runtimeSlot}`} chatId={controller.detail!.record.chat.id} />
          ) : (
            <div role="alert" className="m-auto max-w-lg rounded-2xl border p-8 text-center">
              Shared Chat is unavailable. Reconnect your Matrix account and try again.
            </div>
          )
        ) : <>
        {botMention.recovery ? <BotDraftRecoveryPanel onReturn={botMention.returnToOriginalDraft}/> : null}
        {submissionError || controller.error ? (
          <div role="alert" className={cn("mx-auto mt-3 w-[calc(100%-2.5rem)] rounded-lg border px-3 py-2 text-sm", CHAT_CONTENT_WIDTH_CLASS)} style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>
            {submissionError ?? controller.error}
          </div>
        ) : null}
        {controller.detail && globalView === "conversation" ? (
          <>
            {!directBotId ? chatSharingAction : null}
            <BotChatPanel key={controller.detail.record.chat.id} chatId={controller.detail.record.chat.id} visible={live && !inspectorExclusive}
              client={client.agents} directBotId={directBotId} detailsContainer={frameDetailsContainer ?? botDetailsContainer} headerContainer={botHeaderContainer}
              headerActions={chatSharingAction}
              onModelChanged={() => setBotEventRevision(value => value + 1)} onSetup={openChatProviderSettings} onRefreshCatalog={liveCatalog.refresh} catalog={providerCatalog} catalogLoading={providerCatalogLoading} refreshKey={controller.detail.record.chat.revision + botEventRevision} />
            <ChatContextMenu chatId={controller.detail.record.chat.id}>
            <div className="contents">
            <ConversationTranscript turns={transcript} callbacks={{
              ...artifactActions,
              renderCredentialMarker: (message, offset, marker, number) => {
                if (message.role !== "assistant" || credentialScopeKey === null) return marker;
                const occurrence = credentialDisclosure.occurrences.find((item) =>
                  item.messageId === message.id && item.offset === offset && item.length === marker.length);
                return <ChatCredentialDisclosure marker={marker} number={number} occurrence={occurrence}
                  value={occurrence && !credentialDisclosure.unavailable.includes(occurrence.id) ? credentialDisclosure.values[occurrence.id] : undefined}
                  loaded={credentialDisclosure.loaded} availabilityFailed={credentialDisclosure.availabilityFailed}
                  onReveal={credentialDisclosure.reveal} onHide={credentialDisclosure.hide} />;
              },
              copyText,
              openImportedAsset: importedAssets.openImportedAsset,
              openAttachment: (rawPath) => {
                const path = normalizeDesktopEditorPath(rawPath);
                if (!path || !fileNavigation || !controller.detail) return false;
                fileNavigation.open({ chatId: controller.detail.record.chat.id, target: { kind: "home", path, label: path.split("/").at(-1) ?? path } });
                return true;
              },
              openWebLink: openChatWebLink,
              openFile: (rawPath, executionRoot) => {
                if (!fileNavigation || !controller.detail) return false;
                const scope = resolveWorkFilesScope(controller.detail, projects);
                const target = resolveChatInspectorTargetForRun(
                  rawPath, scope, executionRoot, controller.detail.record.projectId,
                );
                if (!target) return false;
                fileNavigation.open({ chatId: scope.chatId, target });
                return true;
              },
              ...(api ? { loadImage: loadChatImage } : {}),
              submitInput: controller.submitInput,
              performAction: performTranscriptAction,
              canPerformAction: canPerformTranscriptAction,
            }} />
            </div>
            </ChatContextMenu>
            <div className={cn("mx-auto w-full max-w-[808px] shrink-0 px-6 pb-5")}>{composer}</div>
          </>
        ) : globalView === "conversation" && (controller.activeChatId || initialChatId) ? (
          <div
            role="status"
            aria-label="Loading chat"
            className="flex min-h-0 flex-1 items-center justify-center text-sm"
            style={{ color: "var(--text-tertiary)" }}
          >
            Loading chat…
          </div>
        ) : (
          <CanonicalNewChatContent projectId={projectId} showWelcome={projectId === null || globalView === "draft"} workspaceLayout={workspaceLayout} composer={composer} onSelect={setDraft} />
        )}
        </>}
      </SharedChatSurface>
      {renderInspector ? (controller.detail ? renderInspector(controller.detail) : null) : inspector}
      {projectId === null ? (
        <DeleteConversationDialog
          conversation={deleteTarget}
          deleting={deleting}
          error={deleteError}
          onCancel={() => {
            if (deleting) return;
            setDeleteTarget(null);
            setDeleteError(null);
          }}
          onConfirm={() => {
            if (!deleteTarget || deleting) return;
            setDeleting(true);
            void controller.deleteChat(deleteTarget.id).then((deleted) => {
              if (deleted) {
                removeChatDraft(deleteTarget.id);
                setDeleteTarget(null);
                setDeleteError(null);
              } else {
                setDeleteError("The Chat could not be deleted. Try again.");
              }
            }).finally(() => setDeleting(false));
          }}
        />
      ) : null}
    </div></BotModelRecoveryProvider>
  );
}
