import { FolderOpen } from "@renderer/lib/hugeicons";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  defaultAgentThreadComposerDraft,
  defaultSandboxModeForProvider,
  providerReady,
  type AgentThreadComposerDraft,
  type RuntimeSummary,
} from "@matrix-os/contracts";
import type { CanonicalChatClient } from "../../lib/canonical-chat-client";
import { CHAT_CONTENT_WIDTH_CLASS } from "../../components/conversation/layout";
import { cn } from "../../lib/cn";
import { useCodingAgentWorkspace } from "../../stores/coding-agent-workspace";
import { useConnection } from "../../stores/connection";
import { useDraftChat } from "../../stores/draft-chat";
import { useProjectWorkspaces } from "../../stores/project-workspaces";
import { useProviderPreferences } from "../settings/provider-preferences";
import { AttachmentPreviewRow } from "../chat/attachments/AttachmentPreviewRow";
import { useConversationAttachments } from "../chat/attachments/use-conversation-attachments";
import {
  SharedChatComposer,
  supportsNativeFileAttachments,
  type ComposerReferenceToken,
  type SharedChatComposerSubmission,
} from "../chat/SharedChatComposer";
import { SharedChatSurface } from "../chat/SharedChatSurface";
import { searchProjectChatResources } from "../chat/chat-resource-search";
import {
  applyCanonicalSelectionToAgentDraft,
  createLegacyProjectProviderCatalog,
  filterCatalogForLegacyProject,
  instanceIdForLegacyProvider,
  legacyProjectSelectionExecutable,
  permissionModeForAgentDraft,
} from "../chat/canonical-composer-adapter";
import {
  applyCanonicalComposerPreference,
  createCanonicalComposerSelection,
  type CanonicalComposerSelection,
} from "../chat/canonical-composer-state";
import { failClosedProviderCatalog, useChatProviderCatalog } from "../chat/chat-provider-catalog";
import { useProviderSetup } from "../chat/use-provider-setup";
import { capabilityEnabled } from "../coding-agents/capabilities";
import { isTypeToStartInteractiveTarget } from "../coding-agents/type-to-start";
import {
  clearComposerLaunchContext,
  hasComposerContent,
  mergeComposerSeed,
  type ComposerSeed,
} from "../coding-agents/composer-seed";
import { ProjectChatHero } from "./ProjectChatHero";
import { startCanonicalProjectChat } from "./start-canonical-project-chat";

/**
 * The draft-chat pane: shown in the conversation column while no chat is
 * selected. It reuses the exact floating composer bar threads use (PromptInput
 * with provider/mode pickers in the bottom row) under the hero block, so a new
 * chat feels like the existing conversation before it exists. Sending creates
 * the thread implicitly — there is no form step — and the created thread is
 * selected in place, Codex-style.
 */
export function ProjectChatDraft({
  summary,
  projectId,
  projectLabel,
  active,
  seed,
  focusRequestId,
  typeToStartEnabled,
  onCreated,
  canonicalClient,
  canonicalProjectId = projectId,
  onCanonicalCreated,
  presentation = "hero",
  heroHeadline,
}: {
  summary: RuntimeSummary;
  projectId: string;
  projectLabel: string;
  active: boolean;
  seed: ComposerSeed | null;
  focusRequestId: number;
  typeToStartEnabled: boolean;
  onCreated: (threadId: string, label: string) => void;
  canonicalClient?: CanonicalChatClient | null;
  canonicalProjectId?: string;
  onCanonicalCreated?: (chatId: string, label: string) => void;
  presentation?: "hero" | "landing";
  heroHeadline?: string;
}) {
  const preferredProviderId = useProviderPreferences((s) => s.defaultProviderId);
  const composerSelections = useProviderPreferences((s) => s.composerSelections);
  const setComposerSelectionPreference = useProviderPreferences((s) => s.setComposerSelection);
  const api = useConnection((state) => state.api);
  const initialDraft = useMemo(() => {
    const base = defaultAgentThreadComposerDraft(summary);
    const preferred = preferredProviderId
      ? summary.providers.find((provider) => provider.id === preferredProviderId && providerReady(provider))
      : undefined;
    if (!preferred) return base;
    return {
      ...base,
      providerId: preferred.id,
      mode: preferred.defaultMode ?? base.mode,
      sandboxMode: defaultSandboxModeForProvider(preferred),
    };
  }, [summary, preferredProviderId]);
  // Selecting a thread unmounts this pane (the only route to the inspector
  // while drafting); the session-scoped draft store keeps the composed input
  // alive across that round trip. Picker intent is stored independently so an
  // untouched prompt can still adopt a preference that hydrates while closed.
  const [restoredEntry] = useState(() => useDraftChat.getState().draftEntryFor(projectId));
  const restoredDraft = restoredEntry?.draft ?? null;
  const [draft, setDraft] = useState<AgentThreadComposerDraft>(() => {
    if (restoredDraft) return seed ? mergeComposerSeed(restoredDraft, seed.draft) : restoredDraft;
    return seed ? mergeComposerSeed(initialDraft, seed.draft) : initialDraft;
  });
  const providerSelectionTouchedRef = useRef(restoredEntry?.pickerTouched ?? false);
  const attachments = useConversationAttachments();
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const store = useDraftChat.getState();
    const hasPickerChanges = providerSelectionTouchedRef.current
      && (draft.providerId !== initialDraft.providerId || draft.mode !== initialDraft.mode);
    const draftToPersist = providerSelectionTouchedRef.current
      ? draft
      : {
          ...draft,
          providerId: initialDraft.providerId,
          mode: initialDraft.mode,
          sandboxMode: initialDraft.sandboxMode,
        };
    if (hasComposerContent(draftToPersist) || hasPickerChanges) {
      store.setDraft(projectId, draftToPersist, providerSelectionTouchedRef.current);
    } else {
      store.clearDraft(projectId);
    }
  }, [projectId, draft, initialDraft]);
  const createStatus = useCodingAgentWorkspace((s) => s.createStatus);
  const createError = useCodingAgentWorkspace((s) => s.createError);
  const createThread = useCodingAgentWorkspace((s) => s.createThread);
  const refreshSummary = useCodingAgentWorkspace((s) => s.refresh);
  const resolveNewChatTarget = useProjectWorkspaces((s) => s.resolveNewChatTarget);
  const canCreate = capabilityEnabled(summary, "codingAgentsThreadCreate");
  const submitting = createStatus === "submitting";
  const [referenceTokens, setReferenceTokens] = useState<ComposerReferenceToken[]>([]);
  const [resolvingTarget, setResolvingTarget] = useState(false);
  const [canonicalSubmitting, setCanonicalSubmitting] = useState(false);
  const [canonicalError, setCanonicalError] = useState<string | null>(null);
  const submitInFlightRef = useRef(false);
  const busy = submitting || resolvingTarget || canonicalSubmitting;
  // Local focus bumps (type-to-start, chip seeds) combine with the shared
  // composer-focus request id; PromptInput focuses whenever the sum changes.
  const [localFocusBumps, setLocalFocusBumps] = useState(0);
  const focusComposer = () => setLocalFocusBumps((count) => count + 1);

  // Until a picker is touched, provider/mode/sandbox are derived from the current
  // runtime + persisted preference. Prompt and relation state remain local,
  // so late preference hydration never needs an effect that briefly renders a
  // stale provider or overwrites what the user typed.
  const effectiveDraft = providerSelectionTouchedRef.current
    ? draft
    : {
        ...draft,
        providerId: initialDraft.providerId,
        mode: initialDraft.mode,
        sandboxMode: initialDraft.sandboxMode,
      };
  const fallbackCatalog = useMemo(
    () => createLegacyProjectProviderCatalog(summary),
    [summary],
  );
  const liveCatalog = useChatProviderCatalog(fallbackCatalog);
  const unavailableCatalog = useMemo(
    () => failClosedProviderCatalog(fallbackCatalog),
    [fallbackCatalog],
  );
  const projectCatalog = useMemo(
    () => canonicalClient
      ? liveCatalog.status === "ready" ? liveCatalog.catalog : unavailableCatalog
      : filterCatalogForLegacyProject(liveCatalog.catalog, summary),
    [canonicalClient, liveCatalog.catalog, liveCatalog.status, summary, unavailableCatalog],
  );
  const preferredInstanceId = canonicalClient
    ? undefined
    : instanceIdForLegacyProvider(projectCatalog, summary, effectiveDraft.providerId);
  const [canonicalSelection, setCanonicalSelection] = useState<CanonicalComposerSelection | null>(
    () => {
      let selection = createCanonicalComposerSelection(fallbackCatalog, instanceIdForLegacyProvider(
        fallbackCatalog,
        summary,
        restoredDraft?.providerId ?? initialDraft.providerId,
      ));
      if (selection) {
        selection = applyCanonicalComposerPreference(
          fallbackCatalog,
          selection,
          useProviderPreferences.getState().composerSelections[selection.instanceId],
        );
      }
      if (selection && restoredDraft?.mode && fallbackCatalog.instances
        .find((instance) => instance.id === selection.instanceId)
        ?.supports.interactionModes.includes(restoredDraft.mode)) {
        selection.interactionMode = restoredDraft.mode;
      }
      const restoredPermissionMode = permissionModeForAgentDraft(restoredDraft ?? initialDraft);
      if (selection && fallbackCatalog.instances
        .find((instance) => instance.id === selection.instanceId)
        ?.supports.permissionModes.includes(restoredPermissionMode)) {
        selection.permissionMode = restoredPermissionMode;
      }
      return selection;
    },
  );

  useEffect(() => {
    setCanonicalSelection((current) => {
      const currentStillValid = current
        && projectCatalog.instances.some((instance) => (
          instance.id === current.instanceId
          && instance.models.some((model) => model.id === current.model && model.availability === "available")
        ));
      if (providerSelectionTouchedRef.current && currentStillValid) return current;
      const created = createCanonicalComposerSelection(projectCatalog, preferredInstanceId);
      if (!created) return null;
      let next = created;
      if (effectiveDraft.mode && projectCatalog.instances
        .find((instance) => instance.id === next.instanceId)
        ?.supports.interactionModes.includes(effectiveDraft.mode)) {
        next.interactionMode = effectiveDraft.mode;
      }
      const restoredPermissionMode = permissionModeForAgentDraft(effectiveDraft);
      if (projectCatalog.instances
        .find((instance) => instance.id === next.instanceId)
        ?.supports.permissionModes.includes(restoredPermissionMode)) {
        next.permissionMode = restoredPermissionMode;
      }
      next = applyCanonicalComposerPreference(
        projectCatalog,
        next,
        composerSelections[next.instanceId],
      );
      return current
        && current.instanceId === next.instanceId
        && current.model === next.model
        && current.interactionMode === next.interactionMode
        && current.permissionMode === next.permissionMode
        ? current
        : next;
    });
  }, [composerSelections, effectiveDraft.mode, preferredInstanceId, projectCatalog]);
  const selectedInstance = projectCatalog.instances.find((instance) => (
    instance.id === canonicalSelection?.instanceId
  ));
  const canonicalSelectionExecutable = Boolean(
    canonicalSelection
    && selectedInstance?.availability === "available"
    && selectedInstance.models.some((model) => (
      model.id === canonicalSelection.model && model.availability === "available"
    )),
  );
  const canonicalBlocked = canonicalClient
    ? !canonicalSelectionExecutable
    : !legacyProjectSelectionExecutable(projectCatalog, summary, canonicalSelection);
  const handleProviderSetup = useProviderSetup(summary.providers, refreshSummary);

  useEffect(() => {
    void useProviderPreferences.getState().hydrate();
  }, []);

  // Type-to-start while the draft is showing: characters typed outside an
  // editable element append to the draft and move focus into the composer.
  // (The parent view handles the same gesture while a thread is selected —
  // there it deselects first — so exactly one listener is live at a time.)
  useEffect(() => {
    if (!active || !typeToStartEnabled || !canCreate) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
      if (event.key.length !== 1) return;
      if (isTypeToStartInteractiveTarget(event.target)) return;
      setDraft((current) => ({ ...current, prompt: current.prompt + event.key }));
      focusComposer();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, typeToStartEnabled, canCreate]);

  async function submit(submission: SharedChatComposerSubmission) {
    if (canonicalBlocked || submitting || submitInFlightRef.current) return;
    const selectedInstance = projectCatalog.instances.find((instance) => (
      instance.id === canonicalSelection?.instanceId
    ));
    if (attachments.items.length > 0 && !supportsNativeFileAttachments(selectedInstance)) return;
    if (canonicalClient && canonicalSelection) {
      submitInFlightRef.current = true;
      setCanonicalSubmitting(true);
      setCanonicalError(null);
      try {
        const uploaded = await attachments.uploadAll();
        if (!uploaded.ok) return;
        const started = await startCanonicalProjectChat({
          client: canonicalClient,
          projectId: canonicalProjectId,
          submission,
          attachmentPaths: uploaded.attachments.flatMap((attachment) => (
            attachment.path ? [attachment.path] : []
          )),
          selection: canonicalSelection,
        });
        if (!started) return;
        providerSelectionTouchedRef.current = false;
        useDraftChat.getState().clearDraft(projectId);
        setDraft(initialDraft);
        setReferenceTokens([]);
        attachments.clear();
        onCanonicalCreated?.(started.chatId, started.title);
      } catch (error: unknown) {
        console.warn(
          "[project-chat] canonical first turn failed:",
          error instanceof Error ? error.name : "UnknownError",
        );
        setCanonicalError("The message could not be sent. Try again.");
      } finally {
        submitInFlightRef.current = false;
        setCanonicalSubmitting(false);
      }
      return;
    }
    let effective = canonicalSelection
      ? applyCanonicalSelectionToAgentDraft(
          summary,
          projectCatalog,
          { ...effectiveDraft, prompt: submission.agentPrompt },
          canonicalSelection,
        )
      : { ...effectiveDraft, prompt: submission.agentPrompt };
    if (!effective.prompt.trim() && attachments.items.length === 0 && referenceTokens.length === 0) return;
    submitInFlightRef.current = true;
    setResolvingTarget(true);
    try {
      // A draft typed without a seed (plain deselect, direct typing) has no
      // project relation yet — resolve it lazily so the created thread lands in
      // this project's rail. Lock the composer across this await so `effective`
      // remains the exact prompt the user approved for submission.
      if (!effective.projectId) {
        const relation = await resolveNewChatTarget(projectId);
        if (!relation) {
          toast.error("Couldn't start a new chat here. Refresh the workspace and try again.");
          return;
        }
        effective = { ...effective, ...relation };
        setDraft({ ...effective, prompt: effectiveDraft.prompt });
      }
      const uploaded = await attachments.uploadAll();
      if (!uploaded.ok) return;
      const prompt = effective.prompt.trim() || "Please inspect the attached files.";
      const threadId = await createThread({
        ...effective,
        prompt,
        ...(uploaded.attachments.length > 0 ? { attachments: uploaded.attachments } : {}),
      });
      if (!threadId) {
        // Keep the prompt for retry; drop one-shot launch context (review
        // references, task targeting) exactly like the legacy form did.
        setDraft((current) => clearComposerLaunchContext(current));
        return;
      }
      providerSelectionTouchedRef.current = false;
      useDraftChat.getState().clearDraft(projectId);
      setDraft(initialDraft);
      setReferenceTokens([]);
      attachments.clear();
      onCreated(threadId, prompt.replace(/\s+/g, " ").slice(0, 80) || "Agent conversation");
    } finally {
      submitInFlightRef.current = false;
      setResolvingTarget(false);
    }
  }

  const promptEmpty = effectiveDraft.prompt.trim().length === 0
    && attachments.items.length === 0
    && referenceTokens.length === 0;

  return (
    <SharedChatSurface
      ariaLabel={`New chat in ${projectLabel}`}
      project={{ projectId, label: projectLabel }}
      className={`ph-no-capture flex min-w-0 flex-col overflow-visible ${presentation === "landing" ? "shrink-0" : "min-h-[460px] flex-1"}`}
      style={{ background: "var(--bg-app)" }}
      data-slot="project-chat-draft"
      {...attachments.paneProps}
    >
      {presentation === "hero" ? (
        <ProjectChatHero
          projectLabel={projectLabel}
          headline={heroHeadline}
          suggestionsVisible={canCreate && promptEmpty}
          typeToStartEnabled={typeToStartEnabled}
          onSuggestion={(prompt) => {
            setDraft((current) => ({ ...current, prompt }));
            focusComposer();
          }}
        />
      ) : null}
      <div className={`shrink-0 ${presentation === "landing" ? "" : "px-6 pb-5"}`}>
        <div className={cn("@container/project-composer mx-auto w-full", presentation === "landing" ? "max-w-none" : CHAT_CONTENT_WIDTH_CLASS)} data-slot="draft-composer">
          {canonicalError || createError ? (
            <p className="mb-1 px-1 text-xs" style={{ color: "var(--danger)" }}>{canonicalError ?? createError}</p>
          ) : null}
          {canCreate ? (
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
                  value={effectiveDraft.prompt}
                  onChange={(prompt) => setDraft((current) => ({ ...current, prompt }))}
                  referenceTokens={referenceTokens}
                  onReferenceTokensChange={setReferenceTokens}
                  onSubmit={(submission) => void submit(submission)}
                  busy={busy}
                  disabled={busy}
                  canSubmit={!busy && !canonicalBlocked && (
                    effectiveDraft.prompt.trim().length > 0
                    || attachments.items.length > 0
                    || referenceTokens.length > 0
                  )}
                  catalog={projectCatalog}
                  selection={canonicalSelection}
                  onSelectionChange={(selection) => {
                    providerSelectionTouchedRef.current = true;
                    setComposerSelectionPreference(selection);
                    setCanonicalSelection(selection);
                    if (canonicalClient) return;
                    const nextDraft = applyCanonicalSelectionToAgentDraft(
                      summary,
                      projectCatalog,
                      effectiveDraft,
                      selection,
                    );
                    setDraft(nextDraft);
                  }}
                  onProviderSetup={(instance, action) => void handleProviderSetup(instance, action)}
                  instanceLocked={false}
                  menuSide="bottom"
                  resources={[{ kind: "project", id: projectId, label: projectLabel }]}
                  resourceSearch={(query) => api
                    ? searchProjectChatResources(api, projectId, query)
                    : Promise.resolve([])}
                  onAttach={() => fileInputRef.current?.click()}
                  attachments={(
                    <AttachmentPreviewRow
                      items={attachments.items}
                      disabled={busy}
                      onRemove={attachments.remove}
                      onRetry={(localId) => void attachments.retry(localId)}
                    />
                  )}
                  autoFocus={active}
                  focusRequestId={active ? focusRequestId + localFocusBumps : 0}
                  maxLength={24_000}
                  ariaLabel="Message new chat"
                  placeholder={presentation === "landing" ? "How can I help you today?" : "Ask the agent to do anything…"}
                  leadingControls={(
                    <span
                      aria-label={`Project folder ${projectLabel}`}
                      title={projectLabel}
                      className="flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg px-2 text-sm"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      <FolderOpen size={14} aria-hidden className="shrink-0" />
                      <span className="hidden max-w-40 truncate @min-[36rem]/project-composer:inline">{projectLabel}</span>
                    </span>
                  )}
              />
            </>
          ) : (
            <div
              className="rounded-[var(--radius-xl)] border p-4 text-sm"
              style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)", color: "var(--text-secondary)" }}
            >
              Agent runs are not available on this runtime yet.
            </div>
          )}
        </div>
      </div>
    </SharedChatSurface>
  );
}
