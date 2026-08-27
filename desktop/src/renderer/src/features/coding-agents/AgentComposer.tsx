import { Play } from "@renderer/lib/hugeicons";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  defaultAgentThreadComposerDraft,
  defaultSandboxModeForProvider,
  providerReady,
  type AgentThreadComposerDraft,
  type RuntimeSummary,
} from "@matrix-os/contracts";
import { Button } from "../../design/primitives";
import { useCodingAgentWorkspace } from "../../stores/coding-agent-workspace";
import { useProviderPreferences } from "../settings/provider-preferences";
import { AgentWorkspaceSection as Section } from "./AgentWorkspaceSection";
import { capabilityEnabled } from "./capabilities";
import { clearComposerLaunchContext, hasComposerContent, mergeComposerSeed, type ComposerSeed } from "./composer-seed";

// The seed helpers live in composer-seed.ts so the draft-chat pane and this
// legacy panel composer share one implementation; re-export for existing
// imports (ProjectChatsView re-exports them for tests).
export { mergeAttachments, mergeComposerSeed, clearComposerLaunchContext, type ComposerSeed } from "./composer-seed";

// The form-based composer now serves only the legacy path: runtimes without
// the project-workspace capability keep it in the conversation inspector.
// Project Chats uses the draft pane (ProjectChatDraft) instead.
export function AgentComposer({ summary, seed, focusRequestId, onCreated }: {
  summary: RuntimeSummary;
  seed: ComposerSeed | null;
  focusRequestId: number;
  onCreated?: () => void;
}) {
  const preferredProviderId = useProviderPreferences((s) => s.defaultProviderId);
  const initialDraft = useMemo(() => {
    const base = defaultAgentThreadComposerDraft(summary);
    // Honor the saved preference only when that provider can actually start a
    // run. A provider that still needs setup or auth would otherwise replace
    // the ready default and the run would be rejected on submit.
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
  const [draft, setDraft] = useState<AgentThreadComposerDraft>(initialDraft);
  const previousInitialDraftRef = useRef(initialDraft);
  const providerSelectionDirtyRef = useRef(false);
  const modeSelectionDirtyRef = useRef(false);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const createStatus = useCodingAgentWorkspace((s) => s.createStatus);
  const createError = useCodingAgentWorkspace((s) => s.createError);
  const createThread = useCodingAgentWorkspace((s) => s.createThread);
  const canCreate = capabilityEnabled(summary, "codingAgentsThreadCreate");

  useEffect(() => {
    const previousInitialDraft = previousInitialDraftRef.current;
    previousInitialDraftRef.current = initialDraft;
    setDraft((current) => {
      if (!hasComposerContent(current)
        && !providerSelectionDirtyRef.current
        && !modeSelectionDirtyRef.current) return initialDraft;
      // Project/task seeds are launch context, not a provider choice. When the
      // persisted preference hydrates after that context arrives, update only
      // an untouched automatic selection and preserve the seeded fields.
      const followsPreviousDefault = !providerSelectionDirtyRef.current
        && current.providerId === previousInitialDraft.providerId;
      if (!followsPreviousDefault) return current;
      const providerChanged = initialDraft.providerId !== previousInitialDraft.providerId;
      const followsPreviousMode = !modeSelectionDirtyRef.current
        && current.mode === previousInitialDraft.mode;
      return {
        ...current,
        providerId: initialDraft.providerId,
        mode: providerChanged || followsPreviousMode ? initialDraft.mode : current.mode,
        sandboxMode: providerChanged ? initialDraft.sandboxMode : current.sandboxMode,
      };
    });
  }, [initialDraft]);

  useEffect(() => {
    if (!seed) return;
    setDraft((current) => mergeComposerSeed(current, seed.draft));
  }, [seed]);

  useEffect(() => {
    void useProviderPreferences.getState().hydrate();
  }, []);

  useEffect(() => {
    if (focusRequestId <= 0) return;
    promptRef.current?.focus();
  }, [focusRequestId]);

  if (!canCreate) {
    return (
      <Section title="New Run">
        <div
          className="rounded-md border p-3 text-sm"
          style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)", color: "var(--text-secondary)" }}
        >
          Agent runs are not available on this runtime yet.
        </div>
      </Section>
    );
  }

  const selectedProvider = summary.providers.find((provider) => provider.id === draft.providerId);
  const modes = selectedProvider?.supportedModes ?? [];

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submittedDraft = draft;
    const threadId = await createThread(submittedDraft);
    if (!threadId) {
      setDraft((current) => clearComposerLaunchContext(current));
      return;
    }
    providerSelectionDirtyRef.current = false;
    modeSelectionDirtyRef.current = false;
    setDraft(initialDraft);
    onCreated?.();
  }

  return (
    <Section title="New Run">
      <form
        onSubmit={(event) => void submit(event)}
        className="grid gap-3 rounded-md border p-3"
        style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
      >
      <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_180px]">
        <label className="grid gap-1 text-xs" style={{ color: "var(--text-tertiary)" }}>
          Provider
          <select
            className="h-8 rounded-md border px-2 text-sm outline-none"
            style={{
              borderColor: "var(--border-subtle)",
              background: "var(--bg-overlay)",
              color: "var(--text-primary)",
            }}
            value={draft.providerId ?? ""}
            onChange={(event) => {
              const provider = summary.providers.find((candidate) => candidate.id === event.target.value);
              providerSelectionDirtyRef.current = true;
              modeSelectionDirtyRef.current = false;
              setDraft((current) => ({
                ...current,
                providerId: provider?.id,
                mode: provider?.defaultMode ?? current.mode,
                sandboxMode: defaultSandboxModeForProvider(provider),
              }));
            }}
          >
            {summary.providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-xs" style={{ color: "var(--text-tertiary)" }}>
          Mode
          <select
            className="h-8 rounded-md border px-2 text-sm outline-none"
            style={{
              borderColor: "var(--border-subtle)",
              background: "var(--bg-overlay)",
              color: "var(--text-primary)",
            }}
            value={draft.mode ?? ""}
            onChange={(event) => {
              const mode = modes.find((candidate) => candidate === event.target.value);
              if (!mode) return;
              modeSelectionDirtyRef.current = true;
              setDraft((current) => ({ ...current, mode }));
            }}
          >
            {modes.map((mode) => (
              <option key={mode} value={mode}>
                {mode.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="grid gap-1 text-xs" style={{ color: "var(--text-tertiary)" }}>
        <span className="sr-only">Agent run prompt</span>
        <textarea
          ref={promptRef}
          aria-label="Agent run prompt"
          className="min-h-[92px] resize-y rounded-md border px-3 py-2 text-sm outline-none"
          style={{
            borderColor: "var(--border-subtle)",
            background: "var(--bg-overlay)",
            color: "var(--text-primary)",
          }}
          value={draft.prompt}
          onChange={(event) => setDraft((current) => ({ ...current, prompt: event.target.value }))}
        />
      </label>
      <div className="flex items-center justify-between gap-3">
        <p className="min-h-5 text-sm" style={{ color: createError ? "var(--danger)" : "var(--text-tertiary)" }}>
          {createError ?? ""}
        </p>
        <Button variant="primary" type="submit" disabled={createStatus === "submitting"}>
          <Play size={14} />
          {createStatus === "submitting" ? "Starting" : "Start run"}
        </Button>
      </div>
      </form>
    </Section>
  );
}
