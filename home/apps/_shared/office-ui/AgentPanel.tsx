import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { Spinner } from "./Feedback";
import { cx } from "./internal";

export interface AgentMessage {
  id: string;
  role: "user" | "agent";
  text: string;
}

export interface AgentStatusLine {
  id: string;
  text: string;
  state: "pending" | "running" | "done" | "error";
}

export interface AgentResult {
  id: string;
  title: string;
  summary?: ReactNode;
  /** Optional preview, e.g. a redline or a list of cell changes. */
  body?: ReactNode;
  status: "proposed" | "accepted" | "rejected";
  meta?: string;
}

export interface AgentPanelProps {
  onSubmit: (prompt: string) => void;
  title?: string;
  messages?: readonly AgentMessage[];
  statusLines?: readonly AgentStatusLine[];
  results?: readonly AgentResult[];
  onAccept?: (resultId: string) => void;
  onReject?: (resultId: string) => void;
  /** The agent is working: submit is blocked and Stop is shown when onCancel is set. */
  busy?: boolean;
  onCancel?: () => void;
  onClose?: () => void;
  suggestions?: readonly string[];
  placeholder?: string;
  disabled?: boolean;
  /** Shown when there is no conversation yet. */
  emptyHint?: ReactNode;
  /** Prompt length cap (default 32000, the app AI bridge limit). */
  maxLength?: number;
  className?: string;
}

const STATE_LABEL: Record<AgentStatusLine["state"], string> = {
  pending: "Waiting",
  running: "Working",
  done: "Done",
  error: "Failed",
};

/**
 * Conversation-style agent side panel. Presentation only: the host app owns the
 * AI calls and passes messages, status lines and proposed results back in.
 */
export function AgentPanel({
  onSubmit,
  title = "Agent",
  messages = [],
  statusLines = [],
  results = [],
  onAccept,
  onReject,
  busy = false,
  onCancel,
  onClose,
  suggestions = [],
  placeholder = "Ask the agent to edit, summarise or draft…",
  disabled = false,
  emptyHint,
  maxLength = 32000,
  className,
}: AgentPanelProps) {
  const [prompt, setPrompt] = useState("");
  const promptId = useId();
  const headingId = useId();
  const blocked = busy || disabled;

  const submit = (text: string) => {
    const value = text.trim();
    if (!value || blocked) return;
    onSubmit(value.slice(0, maxLength));
    setPrompt("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit(prompt);
    }
  };

  const nothingYet = messages.length === 0 && statusLines.length === 0 && results.length === 0;

  return (
    <section className={cx("oui-agent", className)} aria-labelledby={headingId}>
      <header className="oui-agent__header">
        <h2 id={headingId} className="oui-agent__title">{title}</h2>
        {busy && <Spinner size={14} label="Agent is working" />}
        {onClose && (
          <button type="button" className="oui-icon-button" aria-label={`Close ${title}`} onClick={onClose}>
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3.5 3.5l9 9m0-9l-9 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          </button>
        )}
      </header>

      <div className="oui-agent__feed">
        {nothingYet && (
          <div className="oui-agent__hint">
            {emptyHint ?? <p>Changes the agent proposes appear here for you to accept or reject.</p>}
            {suggestions.length > 0 && (
              <div className="oui-agent__suggestions">
                {suggestions.map((suggestion) => (
                  <button key={suggestion} type="button" className="oui-chip" disabled={blocked} onClick={() => submit(suggestion)}>{suggestion}</button>
                ))}
              </div>
            )}
          </div>
        )}
        {messages.map((message) => (
          <div key={message.id} className={cx("oui-agent__message", `oui-agent__message--${message.role}`)}>
            <span className="oui-sr-only">{message.role === "user" ? "You" : "Agent"}: </span>
            {message.text}
          </div>
        ))}
        <div role="log" aria-live="polite" aria-label="Agent progress" className="oui-agent__status">
          {statusLines.map((line) => (
            <div key={line.id} data-state={line.state} className={cx("oui-agent__line", `is-${line.state}`)}>
              <span className="oui-agent__dot" aria-hidden="true" />
              <span className="oui-sr-only">{STATE_LABEL[line.state]}: </span>
              <span>{line.text}</span>
            </div>
          ))}
        </div>
        {results.map((result) => (
          <ResultCard key={result.id} result={result} onAccept={onAccept} onReject={onReject} />
        ))}
      </div>

      <form
        className="oui-agent__composer"
        onSubmit={(event) => {
          event.preventDefault();
          submit(prompt);
        }}
      >
        <label htmlFor={promptId} className="oui-sr-only">Ask the agent</label>
        <textarea
          id={promptId}
          className="oui-agent__input"
          rows={3}
          value={prompt}
          maxLength={maxLength}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="oui-agent__composer-actions">
          {suggestions.length > 0 && !nothingYet && (
            <div className="oui-agent__suggestions oui-agent__suggestions--inline">
              {suggestions.slice(0, 3).map((suggestion) => (
                <button key={suggestion} type="button" className="oui-chip" disabled={blocked} onClick={() => submit(suggestion)}>{suggestion}</button>
              ))}
            </div>
          )}
          {busy && onCancel ? (
            <button type="button" className="oui-button" onClick={onCancel}>Stop</button>
          ) : (
            <button type="submit" className="oui-button oui-button--primary" aria-label="Send to agent" disabled={blocked || prompt.trim() === ""}>Ask</button>
          )}
        </div>
      </form>
    </section>
  );
}

function ResultCard({ result, onAccept, onReject }: { result: AgentResult; onAccept?: (id: string) => void; onReject?: (id: string) => void }) {
  const titleId = useId();
  return (
    <article aria-labelledby={titleId} className={cx("oui-agent__result", `is-${result.status}`)}>
      <header className="oui-agent__result-header">
        <h3 id={titleId} className="oui-agent__result-title">{result.title}</h3>
        {result.status !== "proposed" && (
          <span className={cx("oui-badge", result.status === "accepted" ? "oui-badge--success" : "oui-badge--danger")}>
            {result.status === "accepted" ? "Accepted" : "Rejected"}
          </span>
        )}
      </header>
      {result.meta && <p className="oui-agent__result-meta">{result.meta}</p>}
      {result.summary && <div className="oui-agent__result-summary">{result.summary}</div>}
      {result.body && <div className="oui-agent__result-body">{result.body}</div>}
      {result.status === "proposed" && (onAccept || onReject) && (
        <div className="oui-agent__result-actions">
          {onAccept && <button type="button" className="oui-button oui-button--success" onClick={() => onAccept(result.id)}>Accept</button>}
          {onReject && <button type="button" className="oui-button oui-button--danger" onClick={() => onReject(result.id)}>Reject</button>}
        </div>
      )}
    </article>
  );
}
