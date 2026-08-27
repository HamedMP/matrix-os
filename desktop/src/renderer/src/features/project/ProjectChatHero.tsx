import { ChatStarterCards } from "../chat/ChatStarterCards";

/**
 * The draft-chat hero block: centered headline, starter actions (only while
 * the draft prompt is empty), and the type-to-start hint. Presentational only —
 * the draft composer itself lives in ProjectChatDraft, anchored at the bottom
 * of the pane exactly like the thread composer.
 */
export function ProjectChatHero({
  projectLabel,
  headline = "What should we work on?",
  suggestionsVisible,
  typeToStartEnabled,
  onSuggestion,
}: {
  projectLabel: string;
  headline?: string;
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
          {headline}
        </h2>
        <p className="text-sm" style={{ color: "var(--text-tertiary)" }}>
          Start a new chat in {projectLabel}
        </p>
      </div>
      {suggestionsVisible ? (
        <ChatStarterCards onSelect={onSuggestion} />
      ) : null}
      {typeToStartEnabled && suggestionsVisible ? (
        <p className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>
          Start typing to begin a new chat
        </p>
      ) : null}
    </div>
  );
}
