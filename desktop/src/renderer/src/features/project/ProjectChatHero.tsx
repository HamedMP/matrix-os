// Suggestion chips seed the same new-chat draft as type-to-start; keep them
// generic enough to be useful for any project shape.
const SUGGESTIONS = [
  "Fix a failing test",
  "Review my recent changes",
  "Explore the codebase",
] as const;

/**
 * The draft-chat hero block: centered headline, suggestion chips (only while
 * the draft prompt is empty), and the type-to-start hint. Presentational only —
 * the draft composer itself lives in ProjectChatDraft, anchored at the bottom
 * of the pane exactly like the thread composer.
 */
export function ProjectChatHero({
  projectLabel,
  suggestionsVisible,
  typeToStartEnabled,
  onSuggestion,
}: {
  projectLabel: string;
  suggestionsVisible: boolean;
  typeToStartEnabled: boolean;
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
      {suggestionsVisible ? (
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
      {typeToStartEnabled && suggestionsVisible ? (
        <p className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>
          Start typing to begin a new chat
        </p>
      ) : null}
    </div>
  );
}
