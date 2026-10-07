import { editionDate, publicationTone } from "./model";
import type { EditionMessage } from "./types";
interface Props {
  message: EditionMessage;
  featured: boolean;
  sourceEmail?: string;
  selected: boolean;
  busy: boolean;
  offline: boolean;
  preview: boolean;
  conflicts: boolean;
  onOpen(): void;
  onSelect(checked: boolean): void;
}
export default function EditionCard({
  message: m,
  featured,
  sourceEmail,
  selected,
  busy,
  offline,
  preview,
  conflicts,
  onOpen,
  onSelect,
}: Props) {
  return (
    <article
      className={
        "edition-card " +
        (featured ? "edition-card-featured " : "") +
        "edition-tone-" +
        publicationTone(m.publication)
      }
    >
      <button
        className="edition-card-open"
        aria-label={"Read " + m.subject}
        onClick={onOpen}
      >
        <div className="edition-cover">
          <span>{m.publication}</span>
          <b>
            {m.publication.charAt(0)}
            <i>✦</i>
          </b>
          <small>{editionDate(m.receivedAt).toUpperCase()}</small>
        </div>
        <div className="edition-card-copy">
          <div className="edition-card-meta">
            <span>{m.publication}</span>
            <span>{editionDate(m.receivedAt)}</span>
          </div>
          <h2>{m.subject}</h2>
          <p>{m.excerpt}</p>
          <div className="edition-card-footer">
            <span className={!m.read ? "edition-unread" : ""}>
              {m.saved ? "Saved for later" : m.read ? "Read" : "Unread"}
            </span>
            <span>Read edition ↗</span>
          </div>
        </div>
      </button>
      <div className="edition-card-account">
        <span>{sourceEmail}</span>
        {!preview && m.classification === "newsletter" && (
          <label>
            <input
              type="checkbox"
              aria-label={"Select " + m.subject + " for inbox cleanup"}
              checked={selected}
              disabled={busy || offline || (!selected && conflicts)}
              onChange={(event) => onSelect(event.target.checked)}
            />
            Select
          </label>
        )}
      </div>
    </article>
  );
}
