import LibraryState from "./LibraryState";
import { useMemo, type Dispatch, type SetStateAction } from "react";
import { publicationGroups, publicationTone } from "./model";
import type { useEdition } from "./useEdition";
import EditionCard from "./EditionCard";
import SourceRetention from "./SourceRetention";
import type { EditionMessage, EditionScope, EditionView } from "./types";
interface Props {
  data: ReturnType<typeof useEdition>;
  visible: EditionMessage[];
  view: EditionView;
  scope: EditionScope;
  query: string;
  sourceId: string;
  publication: string;
  selected: string[];
  setScope(next: EditionScope): void;
  setQuery(next: string): void;
  setSourceId(next: string): void;
  setPublication(next: string): void;
  setSelected: Dispatch<SetStateAction<string[]>>;
  onSetup(): void;
}
export default function Library({
  data,
  visible,
  view,
  scope,
  query,
  sourceId,
  publication,
  selected,
  setScope,
  setQuery,
  setSourceId,
  setPublication,
  setSelected,
  onSetup,
}: Props) {
  const groups = useMemo(() => publicationGroups(visible), [visible]);
  const selectedIds = new Set(selected);
  const sourceEmails = new Map(
    data.sources.map((source) => [source.id, source.email]),
  );
  const messageSources = new Map(
    data.messages.map((message) => [message.id, message.sourceId]),
  );
  const selectedVisible = visible
    .filter((m) => selectedIds.has(m.id) && m.classification === "newsletter")
    .map((m) => m.id);
  return (
    <div className="edition-content">
      <section className="edition-heading">
        <div>
          <span className="edition-eyebrow">A SPACE FOR YOUR CURIOSITY</span>
          <h1>
            {publication ||
              {
                library: "Your library.",
                latest: "Worth your attention.",
                unread: "Take your time.",
                saved: "The keepers.",
                review: "A second look.",
              }[view]}
          </h1>
          <p>
            {view === "review"
              ? "A little judgment keeps your reading room thoughtful."
              : "The newsletters you love. A quiet place to read them."}
          </p>
        </div>
        <div className="edition-date-mark">
          <span>
            {new Date().toLocaleDateString(undefined, { month: "long" })}
          </span>
          <b>{new Date().getDate().toString().padStart(2, "0")}</b>
        </div>
      </section>
      <div className="edition-controls">
        <div
          className="edition-scope"
          role="group"
          aria-label="Reading account group"
        >
          {(["all", "personal", "work"] as const).map((s) => (
            <button
              key={s}
              aria-pressed={scope === s}
              onClick={() => {
                setScope(s);
                setSelected([]);
              }}
            >
              {s === "all"
                ? "All reading"
                : s === "personal"
                  ? "Personal"
                  : "Work"}
            </button>
          ))}
        </div>
        <div className="edition-search">
          <span aria-hidden="true">⌕</span>
          <input
            aria-label="Search editions"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your reading…"
          />
        </div>
        {data.sources.length > 1 && (
          <select
            aria-label="Filter source account"
            value={sourceId}
            onChange={(e) => {
              setSourceId(e.target.value);
              setSelected([]);
            }}
          >
            <option value="">All accounts</option>
            {data.sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.email}
              </option>
            ))}
          </select>
        )}
      </div>
      {data.loading ||
      !data.available ||
      !data.sources.length ||
      !visible.length ? (
        <LibraryState
          data={data}
          visible={visible}
          query={query}
          view={view}
          onSetup={onSetup}
        />
      ) : view === "library" && !publication ? (
        <section
          className="edition-publications"
          aria-label="Publication library"
        >
          {groups.map((g) => (
            <button
              className={
                "edition-publication edition-tone-" + publicationTone(g.name)
              }
              key={g.name}
              onClick={() => setPublication(g.name)}
            >
              <div className="edition-cover">
                <span>{g.name}</span>
                <b>{g.name.charAt(0)}</b>
                <small>LETTERS WORTH KEEPING</small>
              </div>
              <h2>{g.name}</h2>
              <p>
                {g.count} {g.count === 1 ? "edition" : "editions"} · {g.unread}{" "}
                unread <span>→</span>
              </p>
            </button>
          ))}
        </section>
      ) : (
        <section className="edition-feed" aria-label="Newsletter editions">
          {visible.map((m, i) => (
            <EditionCard
              key={m.id}
              message={m}
              featured={i === 0 && view === "latest"}
              sourceEmail={sourceEmails.get(m.sourceId)}
              selected={selectedIds.has(m.id)}
              busy={data.busy}
              offline={data.offline}
              preview={data.preview}
              conflicts={selectedVisible.some(
                (id) => messageSources.get(id) !== m.sourceId,
              )}
              onOpen={() => void data.open(m.id)}
              onSelect={(checked) =>
                setSelected((ids) =>
                  checked
                    ? [...ids, m.id].slice(0, 100)
                    : ids.filter((id) => id !== m.id),
                )
              }
            />
          ))}
        </section>
      )}
      {data.cursor && (
        <button
          className="edition-load-more"
          disabled={data.busy || data.offline}
          onClick={() => void data.loadMore()}
        >
          Load more editions
        </button>
      )}
      {selectedVisible.length > 0 && (
        <div className="edition-cleanup-bar">
          <span>
            {selectedVisible.length} selected · one source account per cleanup
          </span>
          <button
            className="edition-primary"
            disabled={data.busy || data.offline || data.preview}
            onClick={() => void data.cleanupPreview(selectedVisible)}
          >
            Review inbox cleanup
          </button>
        </div>
      )}
      <SourceRetention data={data} />
    </div>
  );
}
