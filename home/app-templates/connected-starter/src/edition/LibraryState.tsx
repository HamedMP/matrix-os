import type { EditionView } from "./types";
import type { useEdition } from "./useEdition";
const emptyTitles: Record<EditionView, string> = {
  saved: "Start your collection.",
  review: "Everything is in its place.",
  library: "A little space for what comes next.",
  latest: "A little space for what comes next.",
  unread: "A little space for what comes next.",
};
export default function LibraryState({
  data,
  visible,
  query,
  view,
  onSetup,
}: {
  data: ReturnType<typeof useEdition>;
  visible: { length: number };
  query: string;
  view: EditionView;
  onSetup(): void;
}) {
  if (data.loading)
    return (
      <div className="edition-empty" role="status">
        <div className="edition-paper-stack" aria-hidden="true">
          ✦
        </div>
        <h2>Opening your reading room…</h2>
        <p>Your saved editions will appear here.</p>
      </div>
    );
  if (!data.available)
    return (
      <div className="edition-empty">
        <div className="edition-paper-stack" aria-hidden="true">
          ✦
        </div>
        <h2>A home for good ideas.</h2>
        <p>
          Open Edition in Matrix to connect email and read your saved
          newsletters.
        </p>
      </div>
    );
  if (data.sources.length === 0)
    return (
      <div className="edition-empty">
        <div className="edition-paper-stack" aria-hidden="true">
          ✦
        </div>
        <h2>Less inbox. More inspiration.</h2>
        <p>
          Bring your favorite newsletters together, from the last three months
          of your email.
        </p>
        <button className="edition-primary" onClick={() => onSetup()}>
          Connect your reading
        </button>
        <small>Email changes always need your approval.</small>
      </div>
    );
  if (visible.length === 0)
    return (
      <div className="edition-empty">
        <h2>{query ? "No editions found." : emptyTitles[view]}</h2>
        <p>
          {query
            ? "Try another publication, title, or account."
            : view === "saved"
              ? "Save an edition while reading to keep it here."
              : "Sync your connected source to find new reading. Partial imports stay visible in your source status below."}
        </p>
      </div>
    );
  return null;
}
