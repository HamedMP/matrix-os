import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  defaultAgentThreadComposerDraft,
  defaultSandboxModeForProvider,
  providerReady,
  type AgentThreadComposerDraft,
  type RuntimeSummary,
} from "@matrix-os/contracts";
import { useCodingAgentWorkspace } from "../../stores/coding-agent-workspace";
import { useDraftChat } from "../../stores/draft-chat";
import { useProjectWorkspaces } from "../../stores/project-workspaces";
import { useProviderPreferences } from "../settings/provider-preferences";
import { PromptInput } from "../chat/elements/prompt-input";
import { AgentComposerPickers } from "../coding-agents/composer-pickers";
import { capabilityEnabled } from "../coding-agents/capabilities";
import { isTypeToStartInteractiveTarget } from "../coding-agents/type-to-start";
import {
  clearComposerLaunchContext,
  mergeComposerSeed,
  type ComposerSeed,
} from "../coding-agents/composer-seed";
import { ProjectChatHero } from "./ProjectChatHero";

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
}: {
  summary: RuntimeSummary;
  projectId: string;
  projectLabel: string;
  active: boolean;
  seed: ComposerSeed | null;
  focusRequestId: number;
  typeToStartEnabled: boolean;
  onCreated: () => void;
}) {
  const preferredProviderId = useProviderPreferences((s) => s.defaultProviderId);
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
  // alive across that round trip. A restored draft counts as provider-touched
  // so the user's earlier picker choices survive verbatim.
  const [restoredDraft] = useState(() => useDraftChat.getState().draftFor(projectId));
  const [draft, setDraft] = useState<AgentThreadComposerDraft>(() => {
    if (restoredDraft) return seed ? mergeComposerSeed(restoredDraft, seed.draft) : restoredDraft;
    return seed ? mergeComposerSeed(initialDraft, seed.draft) : initialDraft;
  });
  const providerSelectionTouchedRef = useRef(restoredDraft !== null);

  useEffect(() => {
    const store = useDraftChat.getState();
    if (draft.prompt.trim().length > 0) store.setDraft(projectId, draft);
    else store.clearDraft(projectId);
  }, [projectId, draft]);
  const createStatus = useCodingAgentWorkspace((s) => s.createStatus);
  const createError = useCodingAgentWorkspace((s) => s.createError);
  const createThread = useCodingAgentWorkspace((s) => s.createThread);
  const resolveNewChatTarget = useProjectWorkspaces((s) => s.resolveNewChatTarget);
  const canCreate = capabilityEnabled(summary, "codingAgentsThreadCreate");
  const submitting = createStatus === "submitting";
  const [resolvingTarget, setResolvingTarget] = useState(false);
  const submitInFlightRef = useRef(false);
  const busy = submitting || resolvingTarget;
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

  async function submit() {
    if (submitting || submitInFlightRef.current) return;
    let effective = effectiveDraft;
    if (!effective.prompt.trim()) return;
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
        setDraft(effective);
      }
      const threadId = await createThread(effective);
      if (!threadId) {
        // Keep the prompt for retry; drop one-shot launch context (review
        // references, task targeting) exactly like the legacy form did.
        setDraft((current) => clearComposerLaunchContext(current));
        return;
      }
      providerSelectionTouchedRef.current = false;
      setDraft(initialDraft);
      onCreated();
    } finally {
      submitInFlightRef.current = false;
      setResolvingTarget(false);
    }
  }

  const selectedProvider = summary.providers.find((provider) => provider.id === effectiveDraft.providerId)
    ?? summary.providers[0];
  const promptEmpty = effectiveDraft.prompt.trim().length === 0;

  return (
    <section
      aria-label={`New chat in ${projectLabel}`}
      className="ph-no-capture flex min-h-[460px] min-w-0 flex-1 flex-col overflow-hidden"
      style={{ background: "var(--bg-app)" }}
      data-slot="project-chat-draft"
    >
      <ProjectChatHero
        projectLabel={projectLabel}
        suggestionsVisible={canCreate && promptEmpty}
        typeToStartEnabled={typeToStartEnabled}
        onSuggestion={(prompt) => {
          setDraft((current) => ({ ...current, prompt }));
          focusComposer();
        }}
      />
      <div className="shrink-0 px-6 pb-5">
        <div className="mx-auto w-full max-w-[46rem]" data-slot="draft-composer">
          {createError ? (
            <p className="mb-1 px-1 text-xs" style={{ color: "var(--danger)" }}>{createError}</p>
          ) : null}
          {canCreate ? (
            <PromptInput
              value={effectiveDraft.prompt}
              onChange={(prompt) => setDraft((current) => ({ ...current, prompt }))}
              onSubmit={() => void submit()}
              busy={busy}
              disabled={busy}
              autoFocus={active}
              focusRequestId={active ? focusRequestId + localFocusBumps : 0}
              maxLength={24_000}
              ariaLabel="Message new chat"
              placeholder="Ask the agent to do anything…"
              controls={(
                <AgentComposerPickers
                  summary={summary}
                  providerId={selectedProvider?.id}
                  mode={effectiveDraft.mode ?? selectedProvider?.defaultMode}
                  onProviderChange={(providerId) => {
                    providerSelectionTouchedRef.current = true;
                    const provider = summary.providers.find((candidate) => candidate.id === providerId);
                    setDraft((current) => ({
                      ...current,
                      providerId: provider?.id,
                      mode: provider?.defaultMode ?? current.mode,
                      sandboxMode: defaultSandboxModeForProvider(provider),
                    }));
                  }}
                  onModeChange={(mode) => {
                    providerSelectionTouchedRef.current = true;
                    setDraft((current) => ({ ...current, mode }));
                  }}
                />
              )}
            />
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
    </section>
  );
}
