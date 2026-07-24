import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  defaultAgentThreadComposerDraft,
  type AgentThreadComposerDraft,
  type RuntimeSummary,
} from "@matrix-os/contracts";
import { useCodingAgentWorkspace } from "../../stores/coding-agent-workspace";
import { useProjectWorkspaces } from "../../stores/project-workspaces";
import { useProviderPreferences } from "../settings/provider-preferences";
import { PromptInput } from "../chat/elements/prompt-input";
import { AgentComposerPickers } from "../coding-agents/composer-pickers";
import { capabilityEnabled } from "../coding-agents/capabilities";
import {
  clearComposerLaunchContext,
  hasComposerContent,
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
      ? summary.providers.find((provider) => provider.id === preferredProviderId)
      : undefined;
    if (!preferred) return base;
    return { ...base, providerId: preferred.id, mode: preferred.defaultMode ?? base.mode };
  }, [summary, preferredProviderId]);
  const [draft, setDraft] = useState<AgentThreadComposerDraft>(initialDraft);
  const createStatus = useCodingAgentWorkspace((s) => s.createStatus);
  const createError = useCodingAgentWorkspace((s) => s.createError);
  const createThread = useCodingAgentWorkspace((s) => s.createThread);
  const resolveNewChatTarget = useProjectWorkspaces((s) => s.resolveNewChatTarget);
  const canCreate = capabilityEnabled(summary, "codingAgentsThreadCreate");
  const submitting = createStatus === "submitting";
  // Local focus bumps (type-to-start, chip seeds) combine with the shared
  // composer-focus request id; PromptInput focuses whenever the sum changes.
  const [localFocusBumps, setLocalFocusBumps] = useState(0);
  const focusComposer = () => setLocalFocusBumps((count) => count + 1);

  // A runtime summary refresh swaps the draft baseline only while the draft
  // carries no user content — typed text and seeded context always survive.
  useEffect(() => {
    setDraft((current) => hasComposerContent(current) ? current : initialDraft);
  }, [initialDraft]);

  useEffect(() => {
    if (!seed) return;
    setDraft((current) => mergeComposerSeed(current, seed.draft));
    focusComposer();
  }, [seed]);

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
      const target = event.target as HTMLElement | null;
      if (
        target
        && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)
      ) {
        return;
      }
      setDraft((current) => ({ ...current, prompt: current.prompt + event.key }));
      focusComposer();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, typeToStartEnabled, canCreate]);

  async function submit() {
    if (submitting) return;
    let effective = draft;
    if (!effective.prompt.trim()) return;
    // A draft typed without a seed (plain deselect, direct typing) has no
    // project relation yet — resolve it lazily so the created thread lands in
    // this project's rail.
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
    setDraft(initialDraft);
    onCreated();
  }

  const selectedProvider = summary.providers.find((provider) => provider.id === draft.providerId)
    ?? summary.providers[0];
  const promptEmpty = draft.prompt.trim().length === 0;

  return (
    <section
      aria-label={`New chat in ${projectLabel}`}
      className="ph-no-capture flex min-h-[460px] min-w-0 flex-1 flex-col overflow-hidden"
      style={{ background: "var(--bg-primary)" }}
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
              value={draft.prompt}
              onChange={(prompt) => setDraft((current) => ({ ...current, prompt }))}
              onSubmit={() => void submit()}
              busy={submitting}
              disabled={submitting}
              autoFocus={active}
              focusRequestId={active ? focusRequestId + localFocusBumps : 0}
              maxLength={24_000}
              ariaLabel="Message new chat"
              placeholder="Ask the agent to do anything…"
              controls={(
                <AgentComposerPickers
                  summary={summary}
                  providerId={selectedProvider?.id}
                  mode={draft.mode ?? selectedProvider?.defaultMode}
                  onProviderChange={(providerId) => {
                    const provider = summary.providers.find((candidate) => candidate.id === providerId);
                    setDraft((current) => ({
                      ...current,
                      providerId: provider?.id,
                      mode: provider?.defaultMode ?? current.mode,
                    }));
                  }}
                  onModeChange={(mode) => setDraft((current) => ({ ...current, mode }))}
                />
              )}
            />
          ) : (
            <div
              className="rounded-2xl border p-4 text-sm"
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
