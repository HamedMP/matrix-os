import { useRef, useState } from "react";
import type {
  MemoryEngine,
  MemorySearchResult,
  MemoryWorkspaceClient,
} from "./model.js";
import { safeMemoryMessage } from "./model.js";
import { MemoryIcon } from "./MemoryIcon.js";
export function MemorySearch({
  client,
  compare,
  onOpenSource,
  onUseInChat,
}: {
  client: MemoryWorkspaceClient;
  compare: boolean;
  onOpenSource(id: string): void;
  onUseInChat?(ids: string[]): Promise<void> | void;
}) {
  const [query, setQuery] = useState("");
  const [engine, setEngine] = useState<MemoryEngine>("hindsight");
  const [results, setResults] = useState<MemorySearchResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  async function search() {
    if (!query.trim() || busy) return;
    const token = ++generation.current;
    setBusy(true);
    setError(null);
    try {
      const next = compare
        ? (await client.compare(query.trim())).results
        : [await client.search(query.trim(), engine)];
      if (token === generation.current) setResults(next);
    } catch (failure) {
      if (token === generation.current) setError(safeMemoryMessage(failure));
    } finally {
      if (token === generation.current) setBusy(false);
    }
  }
  async function use(ids: string[]) {
    setError(null);
    try {
      await onUseInChat?.(ids);
    } catch (failure) {
      setError(safeMemoryMessage(failure));
    }
  }
  return (
    <div className="mw-panel">
      <form
        className="mw-query"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <input
          aria-label="Ask your memory"
          placeholder="What would you like to remember?"
          value={query}
          maxLength={500}
          onChange={(e) => {
            generation.current++;
            setQuery(e.target.value);
            setResults(null);
            setBusy(false);
            setError(null);
          }}
        />
        {!compare && (
          <select
            aria-label="Memory engine"
            value={engine}
            onChange={(e) => {
              generation.current++;
              setEngine(e.target.value as MemoryEngine);
              setResults(null);
              setBusy(false);
              setError(null);
            }}
          >
            <option value="hindsight">Hindsight</option>
            <option value="openviking">OpenViking</option>
          </select>
        )}
        <button
          className="mw-button mw-button-primary"
          disabled={busy || !query.trim()}
        >
          {busy ? "Searching…" : compare ? "Compare" : "Search memory"}
        </button>
      </form>
      <p className="mw-hint">
        {compare
          ? "The same question, the same originals. Inspect each engine’s evidence before using it in Chat."
          : "Search what your memory engines have learned. Every result links back to its original source."}
      </p>
      {error && (
        <p role="alert" className="mw-alert">
          {error}
        </p>
      )}
      {results ? (
        <div className={compare ? "mw-comparison" : ""}>
          {results.map((result) => (
            <section
              className="mw-result-column"
              key={result.engine}
              aria-label={`${result.engine} results`}
            >
              <header className="mw-result-header">
                <h2>
                  {result.engine === "hindsight" ? "Hindsight" : "OpenViking"}
                </h2>
                <span>
                  {result.status === "ready"
                    ? `${Math.round(result.latencyMs)} ms`
                    : result.status === "not_configured"
                      ? "Not configured"
                      : "Unavailable"}
                </span>
              </header>
              {result.status !== "ready" ? (
                <p className="mw-result-empty">
                  {result.status === "not_configured"
                    ? "This engine is not configured on this computer."
                    : "This engine could not respond. Your originals are still available in Library."}
                </p>
              ) : result.hits.length === 0 ? (
                <p className="mw-result-empty">
                  No evidence found. Try another question or check ingestion
                  activity.
                </p>
              ) : (
                result.hits.map((hit, index) => (
                  <article
                    key={`${hit.sourceId}:${index}`}
                    className="mw-evidence"
                  >
                    <span className="mw-eyebrow">
                      {hit.provenance === "summary"
                        ? "Extracted memory"
                        : "Original excerpt"}
                    </span>
                    <p>{hit.text}</p>
                    <div className="mw-evidence-actions">
                      <button
                        className="mw-button"
                        onClick={() => onOpenSource(hit.sourceId)}
                      >
                        <MemoryIcon name="document" size={15} />
                        {hit.citation.label}
                      </button>
                      {onUseInChat && (
                        <button
                          className="mw-button"
                          onClick={() => void use([hit.sourceId])}
                        >
                          <MemoryIcon name="chat" size={15} />
                          Use in Chat
                        </button>
                      )}
                    </div>
                    <p className="mw-hint" style={{ marginBottom: 0 }}>
                      Source revision {hit.citation.revision}
                    </p>
                  </article>
                ))
              )}
            </section>
          ))}
        </div>
      ) : (
        <div className="mw-empty">
          <div className="mw-empty-inner">
            <div className="mw-empty-icon">
              <MemoryIcon name={compare ? "compare" : "memory"} size={28} />
            </div>
            <h2>
              {compare
                ? "Find the memory that works for you"
                : "Recall with a source"}
            </h2>
            <p>
              {compare
                ? "Ask a question about your imported notes, mail or calendar to compare the evidence side by side."
                : "Ask about something in your Library. You can always inspect the original before adding it to a Chat."}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
