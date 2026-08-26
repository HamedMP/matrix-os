import type {
  CanonicalChatClient,
} from "../../lib/canonical-chat-client";
import type {
  CanonicalChatMessagePart,
  CanonicalProviderCatalog,
  KernelConversationContextProjection,
} from "@matrix-os/contracts";
import { MessageSquare, Plus, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ConversationTranscript } from "../../components/conversation/transcript";
import type { ApiClient } from "../../lib/api";
import { useBoard } from "../../stores/board";
import { ChatStarterCards } from "./ChatStarterCards";
import { canonicalChatPresentation } from "./canonical-chat-presentation";
import { createLegacyGlobalProviderCatalog } from "./canonical-composer-adapter";
import {
  createCanonicalComposerSelection,
  type CanonicalComposerSelection,
} from "./canonical-composer-state";
import { useChatProviderCatalog } from "./chat-provider-catalog";
import { searchGlobalChatResources } from "./chat-resource-search";
import ConversationContextPicker from "./ConversationContextPicker";
import {
  SharedChatComposer,
  type ComposerReferenceToken,
  type SharedChatComposerSubmission,
} from "./SharedChatComposer";
import { SharedChatSurface } from "./SharedChatSurface";
import { useCanonicalChatRouteController } from "./use-canonical-chat-route-controller";

function projectContext(
  projectId: string | undefined,
  projects: ReturnType<typeof useBoard.getState>["projects"],
): KernelConversationContextProjection | null {
  if (!projectId) return null;
  const project = projects.find((candidate) => (
    candidate.id === projectId || candidate.slug === projectId
  ));
  return {
    projectId,
    projectName: project?.name ?? projectId,
    projectKind: project?.kind ?? "folder",
    ...(project?.repository ? { repositoryLabel: project.repository } : {}),
    status: project ? "ready" : "unavailable",
  };
}

function inputParts(submission: SharedChatComposerSubmission): CanonicalChatMessagePart[] {
  return [
    ...(submission.text ? [{ type: "text" as const, text: submission.text }] : []),
    ...submission.invocations.map((invocation) => ({
      type: "invocation_reference" as const,
      invocation,
    })),
    ...submission.resources.map((resource) => ({
      type: "resource_reference" as const,
      resource,
    })),
  ];
}

function titleFor(submission: SharedChatComposerSubmission): string {
  return submission.text.replace(/\s+/g, " ").slice(0, 80)
    || submission.invocations[0]?.invocation
    || submission.resources[0]?.label
    || "New chat";
}

export function CanonicalChatWorkspace({
  api,
  client,
  projectId,
  initialChatId,
  projectLabel,
  active,
  catalog,
  onProjectChanged,
}: {
  api?: ApiClient;
  client: CanonicalChatClient;
  projectId: string | null;
  initialChatId?: string;
  projectLabel?: string;
  active: boolean;
  catalog?: CanonicalProviderCatalog;
  onProjectChanged?: (chatId: string, projectId: string | null) => void;
}) {
  const projects = useBoard((state) => state.projects);
  const fallbackCatalog = useMemo(
    () => createLegacyGlobalProviderCatalog({ hasProject: projects.length > 0 }),
    [projects.length],
  );
  const liveCatalog = useChatProviderCatalog(fallbackCatalog).catalog;
  const providerCatalog = catalog ?? liveCatalog;
  const controller = useCanonicalChatRouteController({ client, projectId, active, initialChatId });
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [referenceTokens, setReferenceTokens] = useState<ComposerReferenceToken[]>([]);
  const [selection, setSelection] = useState<CanonicalComposerSelection | null>(() => (
    createCanonicalComposerSelection(providerCatalog)
  ));

  useEffect(() => {
    setSelection((current) => {
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
      return currentSelection && currentSelection.instanceId === next.instanceId
        ? {
            ...next,
            model: currentSelection.model,
            options: currentSelection.options ?? next.options,
          }
        : next;
    });
  }, [controller.detail?.record.chat.currentSelection, controller.detail?.record.providerBinding, providerCatalog]);

  const context = projectContext(controller.detail?.record.projectId, projects);
  const activeRun = controller.detail?.record.activeRun;
  const transcript = controller.detail ? canonicalChatPresentation(controller.detail) : [];
  const copyText = useCallback(async (text: string) => {
    if (!navigator.clipboard?.writeText) throw new Error("ClipboardUnavailable");
    await navigator.clipboard.writeText(text);
  }, []);
  const activeProjectSlug = projects.find((project) => (
    project.id === (controller.detail?.record.projectId ?? projectId)
    || project.slug === (controller.detail?.record.projectId ?? projectId)
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
    const moved = await controller.moveProject(targetProjectId);
    if (moved && targetProjectId !== projectId) onProjectChanged?.(moved.chat.id, targetProjectId);
  };

  const submit = async (submission: SharedChatComposerSubmission) => {
    if (!selection || activeRun) return;
    const parts = inputParts(submission);
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
    }, titleFor(submission));
    if (!admitted) return;
    setDraft("");
    setReferenceTokens([]);
  };

  const composer = (
    <SharedChatComposer
      value={draft}
      onChange={setDraft}
      referenceTokens={referenceTokens}
      onReferenceTokensChange={setReferenceTokens}
      onSubmit={(submission) => void submit(submission)}
      onAbort={activeRun ? () => void controller.cancelActiveRun() : undefined}
      busy={Boolean(activeRun)}
      disabled={controller.status === "loading"}
      canSubmit={Boolean(selection && !activeRun && (draft.trim() || referenceTokens.length > 0))}
      catalog={providerCatalog}
      selection={selection}
      onSelectionChange={setSelection}
      instanceLocked={controller.detail?.record.providerBinding !== undefined}
      resources={resources}
      resourceSearch={resourceSearch}
      onNewChat={controller.startNewChat}
      placeholder={controller.detail ? "Reply to chat…" : "How can I help you today?"}
      ariaLabel={controller.detail ? "Reply to chat" : "Start a chat"}
      leadingControls={(
        <ConversationContextPicker
          context={context}
          compact={!context}
          disabled={!controller.detail || Boolean(activeRun)}
          onSelect={(targetProjectSlug) => {
            const target = projects.find((project) => project.slug === targetProjectSlug);
            void moveProject(target?.id ?? targetProjectSlug);
          }}
          onRemove={() => void moveProject(null)}
        />
      )}
    />
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden" data-slot="canonical-chat-workspace">
      <aside
        aria-label={projectId ? "Project chats" : "Global chats"}
        className="flex w-[260px] shrink-0 flex-col border-r p-3"
        style={{ borderColor: "var(--border-subtle)", background: "var(--bg-sunken)" }}
      >
        <div className="flex items-center justify-between gap-2 px-1 pb-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
              {projectId ? projectLabel ?? "Project chats" : "Chats"}
            </h2>
            <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>
              {projectId ? "Project" : "Global"}
            </p>
          </div>
          <button
            type="button"
            aria-label="New chat"
            className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-[var(--bg-hover)]"
            onClick={controller.startNewChat}
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
              onClick={() => controller.selectChat(record.chat.id)}
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
      </aside>
      <SharedChatSurface
        ariaLabel={projectId ? "Project Chat" : "Global Chat"}
        project={projectId ? { projectId, label: projectLabel ?? projectId } : undefined}
        className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      >
        {controller.error ? (
          <div role="alert" className="mx-auto mt-3 w-[calc(100%-2.5rem)] max-w-[868px] rounded-lg border px-3 py-2 text-sm" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>
            {controller.error}
          </div>
        ) : null}
        {controller.detail ? (
          <>
            <ConversationTranscript turns={transcript} callbacks={{ copyText }} />
            <div className="mx-auto w-full max-w-[868px] shrink-0 px-5 pb-5">{composer}</div>
          </>
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
    </div>
  );
}
