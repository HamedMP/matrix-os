import { Play } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  defaultAgentThreadComposerDraft,
  type AgentThreadComposerDraft,
  type RuntimeSummary,
} from "@matrix-os/contracts";
import { Button } from "../../design/primitives";
import { useCodingAgentWorkspace } from "../../stores/coding-agent-workspace";
import { useProviderPreferences } from "../settings/provider-preferences";
import { AgentWorkspaceSection as Section } from "./AgentWorkspaceSection";
import { capabilityEnabled } from "./capabilities";
import { clearComposerLaunchContext, mergeComposerSeed, type ComposerSeed } from "./composer-seed";

// The seed helpers live in composer-seed.ts so the draft-chat pane and this
// legacy panel composer share one implementation; re-export for existing
// imports (ProjectChatsView re-exports them for tests).
export { mergeAttachments, mergeComposerSeed, clearComposerLaunchContext, type ComposerSeed } from "./composer-seed";

function hasComposerContent(current: AgentThreadComposerDraft): boolean {
  return current.prompt.trim().length > 0
    || Boolean(current.projectId)
    || Boolean(current.taskId)
    || Boolean(current.terminalSessionId)
    || Boolean(current.worktreeId)
    || Boolean(current.attachments?.length);
}

export function AgentComposer({ summary, seed, focusRequestId, onCreated, variant = "panel" }: {
  summary: RuntimeSummary;
  seed: ComposerSeed | null;
  focusRequestId: number;
  onCreated?: () => void;
  // "panel" keeps the inspector's titled Section card; "hero" renders the bare
  // form as a floating prompt-card for the project Chats hero empty state.
  variant?: "panel" | "hero";
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
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const createStatus = useCodingAgentWorkspace((s) => s.createStatus);
  const createError = useCodingAgentWorkspace((s) => s.createError);
  const createThread = useCodingAgentWorkspace((s) => s.createThread);
  const canCreate = capabilityEnabled(summary, "codingAgentsThreadCreate");

  useEffect(() => {
    setDraft((current) => hasComposerContent(current) ? current : initialDraft);
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
    const notice = (
      <div
        className="rounded-md border p-3 text-sm"
        style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)", color: "var(--text-secondary)" }}
      >
        Agent runs are not available on this runtime yet.
      </div>
    );
    return variant === "hero" ? notice : <Section title="New Run">{notice}</Section>;
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
    setDraft(initialDraft);
    onCreated?.();
  }

  const form = (
    <form
      onSubmit={(event) => void submit(event)}
      className={variant === "hero"
        ? "prompt-card grid gap-3 rounded-2xl border p-4"
        : "grid gap-3 rounded-md border p-3"}
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
              setDraft((current) => ({
                ...current,
                providerId: provider?.id,
                mode: provider?.defaultMode ?? current.mode,
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
  );
  return variant === "hero" ? form : <Section title="New Run">{form}</Section>;
}
