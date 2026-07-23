import type { RuntimeSummary } from "@matrix-os/contracts";
import { AgentComposer, type ComposerSeed } from "../coding-agents/AgentComposer";

// Suggestion chips seed the same new-chat path as type-to-start; keep them
// generic enough to be useful for any project shape.
const SUGGESTIONS = [
  "Fix a failing test",
  "Review my recent changes",
  "Explore the codebase",
] as const;

/**
 * The project Chats hero: shown in the conversation pane while no chat is
 * selected. Centers a headline, the existing new-chat composer (hero variant,
 * not a fork), and suggestion chips that seed it. The thread rail and the
 * inspector are unaffected — this replaces only the old "Select a chat" pane.
 */
export function ProjectChatHero({
  summary,
  projectLabel,
  seed,
  focusRequestId,
  canCreate,
  onCreated,
  onSuggestion,
}: {
  summary: RuntimeSummary;
  projectLabel: string;
  seed: ComposerSeed | null;
  focusRequestId: number;
  canCreate: boolean;
  onCreated: () => void;
  onSuggestion: (prompt: string) => void;
}) {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 overflow-y-auto px-6 py-10"
      data-slot="project-chat-hero"
    >
      <div className="flex flex-col items-center gap-2 text-center">
        <h2 className="text-xl font-semibold" style={{ color: "var(--text-primary)" }}>
          What should we work on?
        </h2>
        <p className="text-sm" style={{ color: "var(--text-tertiary)" }}>
          Start a new chat in {projectLabel}
        </p>
      </div>
      <div className="w-full max-w-[46rem]">
        <AgentComposer
          summary={summary}
          seed={seed}
          focusRequestId={focusRequestId}
          onCreated={onCreated}
          variant="hero"
        />
      </div>
      {canCreate ? (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {SUGGESTIONS.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => onSuggestion(suggestion)}
              className="rounded-full border px-3 py-1.5 text-xs transition-colors hover:bg-[var(--bg-hover)]"
              style={{
                borderColor: "var(--border-subtle)",
                background: "var(--bg-surface)",
                color: "var(--text-secondary)",
              }}
            >
              {suggestion}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
