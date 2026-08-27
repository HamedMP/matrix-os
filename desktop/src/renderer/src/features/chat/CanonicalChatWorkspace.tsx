import type {
  CanonicalChatClient,
} from "../../lib/canonical-chat-client";
import type {
  AgentProviderSummary,
  CanonicalChatMessagePart,
  CanonicalProviderCatalog,
  KernelConversationContextProjection,
} from "@matrix-os/contracts";
import { MessageSquare, Plus, Search } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ConversationTranscript } from "../../components/conversation/transcript";
import type { ApiClient } from "../../lib/api";
import { useBoard } from "../../stores/board";
import { useCodingAgentWorkspace } from "../../stores/coding-agent-workspace";
import { captureRuntimeGeneration, isCurrentRuntimeGeneration } from "../../stores/runtime-generation";
import { AttachmentPreviewRow } from "./attachments/AttachmentPreviewRow";
import { useConversationAttachments } from "./attachments/use-conversation-attachments";
import { ChatStarterCards } from "./ChatStarterCards";
import { CanonicalChatIndex } from "./CanonicalChatIndex";
import { DeleteConversationDialog } from "./DeleteConversationDialog";
import { canonicalChatPresentation } from "./canonical-chat-presentation";
import { canonicalChatInputParts, canonicalChatTitle } from "./canonical-chat-submission";
import { createLegacyGlobalProviderCatalog } from "./canonical-composer-adapter";
import {
  createCanonicalComposerSelection,
  type CanonicalComposerSelection,
} from "./canonical-composer-state";
import { failClosedProviderCatalog, useChatProviderCatalog } from "./chat-provider-catalog";
import { canonicalResourceReferenceForPath, searchGlobalChatResources } from "./chat-resource-search";
import ConversationContextPicker from "./ConversationContextPicker";
import {
  SharedChatComposer,
  supportsNativeFileAttachments,
  type ComposerReferenceToken,
  type SharedChatComposerSubmission,
} from "./SharedChatComposer";
import { SharedChatSurface } from "./SharedChatSurface";
import { useCanonicalChatRouteController } from "./use-canonical-chat-route-controller";
import { useProviderSetup } from "./use-provider-setup";

const EMPTY_PROVIDER_SUMMARIES: AgentProviderSummary[] = [];

function rememberedOptions(
  catalog: CanonicalProviderCatalog,
  selection: CanonicalComposerSelection,
) {
  const instance = catalog.instances.find((candidate) => candidate.id === selection.instanceId);
  if (!instance) return [];
  return selection.options.filter((selected) => {
    const descriptor = instance.options.find((candidate) => candidate.id === selected.id);
    if (!descriptor) return false;
    if (descriptor.kind === "boolean") return typeof selected.value === "boolean";
    return typeof selected.value === "string"
      && descriptor.values?.some((candidate) => candidate.value === selected.value) === true;
  });
}

function projectContext(
  projectId: string | undefined,
  projects: ReturnType<typeof useBoard.getState>["projects"],
  fallbackLabel?: string,
): KernelConversationContextProjection | null {
  if (!projectId) return null;
  const project = projects.find((candidate) => (
    candidate.id === projectId || candidate.slug === projectId
  ));
  return {
    projectId,
    projectName: project?.name ?? fallbackLabel ?? projectId,
    projectKind: project?.kind ?? "folder",
    ...(project?.repository ? { repositoryLabel: project.repository } : {}),
    status: project || fallbackLabel ? "ready" : "unavailable",
  };
}

export function CanonicalChatWorkspace({
  api,
  client,
  projectId,
  initialChatId,
  initialView,
  projectLabel,
  active,
  catalog,
  inspector,
  onProjectChanged,
  onActiveChatChanged,
  onChatDeleted,
}: {
  api?: ApiClient;
  client: CanonicalChatClient;
  projectId: string | null;
  initialChatId?: string;
  initialView?: "index" | "draft" | "conversation";
  projectLabel?: string;
  active: boolean;
  catalog?: CanonicalProviderCatalog;
  inspector?: ReactNode;
  onProjectChanged?: (chatId: string, projectId: string | null, title: string) => void;
  onActiveChatChanged?: (chatId: string | null, title?: string) => void;
  onChatDeleted?: (chatId: string) => void;
}) {
  const projects = useBoard((state) => state.projects);
  const fallbackCatalog = useMemo(
    () => createLegacyGlobalProviderCatalog({ hasProject: projects.length > 0 }),
    [projects.length],
  );
  const liveCatalog = useChatProviderCatalog(fallbackCatalog, api ?? null, active);
  const unavailableCatalog = useMemo(() => failClosedProviderCatalog(fallbackCatalog), [fallbackCatalog]);
  const providerCatalog = catalog ?? (
    liveCatalog.status === "ready" ? liveCatalog.catalog : unavailableCatalog
  );
  const controller = useCanonicalChatRouteController({
    client,
    projectId,
    active,
    initialChatId,
    autoSelectFirst: false,
  });
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [referenceTokens, setReferenceTokens] = useState<ComposerReferenceToken[]>([]);
  const [draftProjectId, setDraftProjectId] = useState<string | null>(projectId);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const [globalView, setGlobalView] = useState<"index" | "draft" | "conversation">(
    initialView ?? (initialChatId ? "conversation" : "index"),
  );
  const previousRoute = useRef({ initialChatId, initialView, projectId });
  const reportedChatId = useRef<string | null>(initialChatId ?? null);
  const submissionSequence = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachments = useConversationAttachments(controller.activeChatId, api ?? null);
  const runtimeSummary = useCodingAgentWorkspace((state) => state.summary);
  const runtimeStatus = useCodingAgentWorkspace((state) => state.status);
  const refreshRuntimeSummary = useCodingAgentWorkspace((state) => state.refresh);
  const handleProviderSetup = useProviderSetup(
    runtimeSummary?.providers ?? EMPTY_PROVIDER_SUMMARIES,
    refreshRuntimeSummary,
    api ?? null,
  );
  const [selection, setSelection] = useState<CanonicalComposerSelection | null>(() => (
    catalog ? createCanonicalComposerSelection(providerCatalog) : null
  ));
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    if (!api || runtimeStatus !== "idle") return;
    void refreshRuntimeSummary();
  }, [api, refreshRuntimeSummary, runtimeStatus]);

  useLayoutEffect(() => {
    const previous = previousRoute.current;
    if (
      previous.initialChatId === initialChatId
      && previous.initialView === initialView
      && previous.projectId === projectId
    ) return;
    previousRoute.current = { initialChatId, initialView, projectId };
    if (projectId !== null) return;
    setGlobalView(initialView ?? (initialChatId ? "conversation" : "index"));
  }, [initialChatId, initialView, projectId]);

  useLayoutEffect(() => {
    submissionSequence.current += 1;
    setUploadingAttachments(false);
  }, [client]);

  useEffect(() => {
    setSelection((current) => {
      if (!catalog && liveCatalog.status !== "ready") return null;
      const boundInstance = controller.detail?.record.providerBinding?.instanceId;
      const currentInstance = providerCatalog.instances.find((instance) => instance.id === current?.instanceId);
      const requiredInstance = boundInstance
        ? providerCatalog.instances.find((instance) => instance.id === boundInstance)
        : currentInstance;
      const next = requiredInstance
        ? createCanonicalComposerSelection(providerCatalog, requiredInstance.id)
        : createCanonicalComposerSelection(providerCatalog);
      if (!next) return null;
      const currentSelection = controller.detail?.record.chat.currentSelection;
      const rememberedModel = currentSelection && currentSelection.instanceId === next.instanceId
        ? requiredInstance?.models.find((model) => (
            model.id === currentSelection.model && model.availability === "available"
          ))
        : undefined;
      return currentSelection && rememberedModel
        ? {
            ...next,
            model: currentSelection.model,
            options: rememberedOptions(providerCatalog, {
              ...next,
              options: currentSelection.options ?? next.options,
            }),
          }
        : next;
    });
  }, [catalog, controller.detail?.record.chat.currentSelection, controller.detail?.record.providerBinding, liveCatalog.status, providerCatalog]);

  useEffect(() => {
    const record = controller.detail?.record;
    if (!record || reportedChatId.current === record.chat.id) return;
    reportedChatId.current = record.chat.id;
    onActiveChatChanged?.(record.chat.id, record.chat.title);
  }, [controller.detail?.record, onActiveChatChanged]);

  const context = projectContext(
    controller.detail?.record.projectId ?? draftProjectId ?? projectId ?? undefined,
    projects,
    projectLabel,
  );
  const activeRun = controller.detail?.record.activeRun;
  const transcript = controller.detail ? canonicalChatPresentation(controller.detail) : [];
  const copyText = useCallback(async (text: string) => {
    if (!navigator.clipboard?.writeText) throw new Error("ClipboardUnavailable");
    await navigator.clipboard.writeText(text);
  }, []);
  const activeProjectSlug = projects.find((project) => (
    project.id === (controller.detail?.record.projectId ?? draftProjectId ?? projectId)
    || project.slug === (controller.detail?.record.projectId ?? draftProjectId ?? projectId)
  ))?.slug;
  const resourceSearch = useCallback((resourceQuery: string) => (
    api
      ? searchGlobalChatResources(api, activeProjectSlug ?? null, resourceQuery)
      : Promise.resolve([])
  ), [activeProjectSlug, api]);
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

  const submit = async (submission: SharedChatComposerSubmission) => {
    const selectedInstance = providerCatalog.instances.find((instance) => instance.id === selection?.instanceId);
    if (
      !selection
      || activeRun
      || uploadingAttachments
      || (attachments.items.length > 0 && !supportsNativeFileAttachments(selectedInstance))
    ) return;
    const runtimeGeneration = captureRuntimeGeneration();
    const sequence = ++submissionSequence.current;
    const isCurrentSubmission = () => (
      sequence === submissionSequence.current
      && isCurrentRuntimeGeneration(runtimeGeneration)
    );
    setUploadingAttachments(true);
    try {
      const uploaded = await attachments.uploadAll();
      if (!uploaded.ok || !isCurrentSubmission()) return;
      const uploadedParts: CanonicalChatMessagePart[] = uploaded.attachments.flatMap((attachment) => (
        attachment.path
          ? [{
              type: "resource_reference" as const,
              resource: canonicalResourceReferenceForPath("file", attachment.path),
            }]
          : []
      ));
      const parts = [...canonicalChatInputParts(submission), ...uploadedParts];
      if (parts.length === 0) return;
      const admitted = await controller.submitTurn({
        parts,
        selection: {
          instanceId: selection.instanceId,
          model: selection.model,
          ...(selection.options.length > 0 ? { options: selection.options } : {}),
        },
        interactionMode: selection.interactionMode,
        permissionMode: selection.permissionMode,
      }, canonicalChatTitle(submission), draftProjectId ?? projectId);
      if (!admitted || !isCurrentSubmission()) return;
      reportedChatId.current = admitted.record.chat.id;
      const admittedProjectId = admitted.record.projectId ?? null;
      if (admittedProjectId !== projectId && onProjectChanged) {
        onProjectChanged(admitted.record.chat.id, admittedProjectId, admitted.record.chat.title);
      } else {
        onActiveChatChanged?.(admitted.record.chat.id, admitted.record.chat.title);
      }
      setGlobalView("conversation");
      setDraftProjectId(admittedProjectId);
      setDraft("");
      setReferenceTokens([]);
      attachments.clear();
    } finally {
      if (sequence === submissionSequence.current) setUploadingAttachments(false);
    }
  };

  const startNewChat = () => {
    controller.startNewChat();
    reportedChatId.current = null;
    onActiveChatChanged?.(null);
    setDraftProjectId(projectId);
    if (projectId === null) setGlobalView("draft");
  };

  const selectChat = (chatId: string) => {
    controller.selectChat(chatId);
    const selected = controller.items.find((item) => item.chat.id === chatId);
    reportedChatId.current = chatId;
    onActiveChatChanged?.(chatId, selected?.chat.title);
    if (projectId === null) setGlobalView("conversation");
  };

  const composer = (
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
      <SharedChatComposer
        value={draft}
        onChange={setDraft}
        referenceTokens={referenceTokens}
        onReferenceTokensChange={setReferenceTokens}
        onSubmit={(submission) => void submit(submission)}
        onAbort={activeRun ? () => void controller.cancelActiveRun() : undefined}
        busy={Boolean(activeRun) || uploadingAttachments}
        disabled={controller.status === "loading" || uploadingAttachments || (!catalog && liveCatalog.status === "loading")}
        canSubmit={Boolean(selection && !activeRun && !uploadingAttachments && (
          draft.trim() || referenceTokens.length > 0 || attachments.items.length > 0
        ))}
        catalog={providerCatalog}
        selection={selection}
        onSelectionChange={setSelection}
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
        placeholder={controller.detail ? "Reply to chat…" : "How can I help you today?"}
        ariaLabel={controller.detail ? "Reply to chat" : "Start a chat"}
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
      />
    </>
  );

  if (projectId === null && globalView === "index") {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden" data-slot="canonical-chat-workspace">
        <CanonicalChatIndex
          items={controller.items}
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
        />
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
                onChatDeleted?.(deleteTarget.id);
                setDeleteTarget(null);
                setDeleteError(null);
              } else {
                setDeleteError("The Chat could not be deleted. Try again.");
              }
            }).finally(() => setDeleting(false));
          }}
        />
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden" data-slot="canonical-chat-workspace">
      {projectId ? <aside
        aria-label="Project chats"
        className="flex w-[260px] shrink-0 flex-col border-r p-3"
        style={{ borderColor: "var(--border-subtle)", background: "var(--bg-sunken)" }}
      >
        <div className="flex items-center justify-between gap-2 px-1 pb-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
              {projectLabel ?? "Project chats"}
            </h2>
            <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>
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
            className="h-9 w-full rounded-lg border bg-transparent pl-8 pr-2 text-sm outline-none focus:border-[var(--accent)]"
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
            <button
              key={record.chat.id}
              type="button"
              aria-label={record.chat.title}
              aria-pressed={record.chat.id === controller.activeChatId}
              className="w-full rounded-lg px-2.5 py-2 text-left hover:bg-[var(--bg-hover)] aria-pressed:bg-[var(--bg-selected)]"
              onClick={() => selectChat(record.chat.id)}
            >
              <span className="block truncate text-sm font-medium" style={{ color: "var(--text-primary)" }}>
                {record.chat.title}
              </span>
              <span className="block truncate text-xs" style={{ color: "var(--text-tertiary)" }}>
                {record.chat.lastMessagePreview ?? "No messages yet"}
              </span>
            </button>
          ))}
          {controller.status === "ready" && controller.items.length === 0 ? (
            <p className="px-2 py-3 text-xs" style={{ color: "var(--text-tertiary)" }}>No chats yet.</p>
          ) : null}
        </div>
      </aside> : null}
      <SharedChatSurface
        ariaLabel={projectId ? "Project Chat" : "Global Chat"}
        project={projectId ? { projectId, label: projectLabel ?? projectId } : undefined}
        className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
        {...attachments.paneProps}
      >
        {controller.error ? (
          <div role="alert" className="mx-auto mt-3 w-[calc(100%-2.5rem)] max-w-[868px] rounded-lg border px-3 py-2 text-sm" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>
            {controller.error}
          </div>
        ) : null}
        {controller.detail ? (
          <>
            <ConversationTranscript
              turns={transcript}
              callbacks={{
                copyText,
                canPerformAction: (action) => action.kind === "retry",
                performAction: async (action) => {
                  if (action.kind === "retry") await controller.retryTurn(action.turnId);
                },
              }}
            />
            <div className="mx-auto w-full max-w-[868px] shrink-0 px-5 pb-5">{composer}</div>
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
          <div className="mx-auto flex min-h-0 w-full max-w-[868px] flex-1 flex-col justify-center gap-[26px] px-5 py-8">
            <div className="flex flex-col items-center gap-3 text-center">
              <MessageSquare size={28} aria-hidden style={{ color: "var(--text-tertiary)" }} />
              <h1 className="text-[32px] font-semibold leading-tight tracking-[-0.02em]" style={{ color: "var(--text-primary)" }}>
                What should we build today?
              </h1>
            </div>
            <ChatStarterCards onSelect={setDraft} />
            {composer}
          </div>
        )}
      </SharedChatSurface>
      {inspector}
    </div>
  );
}
