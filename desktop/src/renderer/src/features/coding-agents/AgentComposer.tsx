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

export type ComposerSeed = {
  seedId: number;
  draft: AgentThreadComposerDraft;
};

export function mergeAttachments(
  current: AgentThreadComposerDraft["attachments"],
  seeded: AgentThreadComposerDraft["attachments"],
): AgentThreadComposerDraft["attachments"] {
  const currentAttachments = current ?? [];
  const seededById = new Map((seeded ?? []).map((attachment) => [attachment.id, attachment]));
  const merged = currentAttachments.map((attachment) => seededById.get(attachment.id) ?? attachment);
  const seen = new Set(merged.map((attachment) => attachment.id));
  for (const attachment of seeded ?? []) {
    if (seen.has(attachment.id) || merged.length >= 8) continue;
    seen.add(attachment.id);
    merged.push(attachment);
  }
  return merged.length ? merged : undefined;
}

export function mergeComposerSeed(current: AgentThreadComposerDraft, seeded: AgentThreadComposerDraft): AgentThreadComposerDraft {
  const currentPrompt = current.prompt.trim();
  const seededPrompt = seeded.prompt.trim();
  const attachments = mergeAttachments(current.attachments, seeded.attachments);
  const missingRequiredReference = (seeded.attachments ?? [])
    .some((attachment) => attachment.kind === "structured_ref"
      && !attachments?.some((candidate) => candidate.id === attachment.id));
  if (missingRequiredReference) return current;

  return {
    ...seeded,
    providerId: current.providerId ?? seeded.providerId,
    mode: current.mode ?? seeded.mode,
    approvalPolicy: current.approvalPolicy ?? seeded.approvalPolicy,
    sandboxMode: current.sandboxMode ?? seeded.sandboxMode,
    prompt: !seededPrompt
      ? current.prompt
      : currentPrompt && currentPrompt !== seededPrompt
        ? `${current.prompt.trimEnd()}\n\n---\n\n${seeded.prompt}`
        : seeded.prompt,
    attachments,
  };
}

export function clearComposerLaunchContext(current: AgentThreadComposerDraft): AgentThreadComposerDraft {
  const attachments = current.attachments?.filter((attachment) => attachment.kind !== "structured_ref");
  return {
    ...current,
    projectId: undefined,
    taskId: undefined,
    terminalSessionId: undefined,
    worktreeId: undefined,
    attachments: attachments?.length ? attachments : undefined,
  };
}

function hasComposerContent(current: AgentThreadComposerDraft): boolean {
  return current.prompt.trim().length > 0
    || Boolean(current.projectId)
    || Boolean(current.taskId)
    || Boolean(current.terminalSessionId)
    || Boolean(current.worktreeId)
    || Boolean(current.attachments?.length);
}

export function AgentComposer({ summary, seed, focusRequestId, onCreated }: { summary: RuntimeSummary; seed: ComposerSeed | null; focusRequestId: number; onCreated?: () => void }) {
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
    </Section>
  );
}
