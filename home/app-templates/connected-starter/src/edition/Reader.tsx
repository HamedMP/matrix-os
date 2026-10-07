import Dialog from "./Dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { editionDate, readingMinutes } from "./model";
import type { EditionMessage, EditionSource, ReadingPatch } from "./types";
interface Props {
  message: EditionMessage;
  source?: EditionSource;
  busy: boolean;
  offline: boolean;
  downloaded: boolean;
  canDownload: boolean;
  onClose: () => void;
  onReading: (p: Omit<ReadingPatch, "id" | "baseRevision">) => Promise<void>;
  onCorrect: (c: "newsletter" | "other") => Promise<void>;
  onDownload: () => Promise<void>;
  onRemoveDownload: () => Promise<void>;
  onExport: () => Promise<void>;
  onDelete: () => Promise<void>;
  preview: boolean;
}
export default function Reader(p: Props) {
  const paragraphs = useMemo(() => {
    const seen: Record<string, number> = {};
    return (p.message.text ?? p.message.excerpt)
      .split(/\n\s*\n/)
      .map((text) => {
        const count = (seen[text] ?? 0) + 1;
        seen[text] = count;
        return { id: `${text}:${count}`, text };
      });
  }, [p.message.text, p.message.excerpt]);
  const reader = useRef<HTMLElement>(null);
  const [size, setSize] = useState(20),
    [progress, setProgress] = useState(p.message.progress),
    [deleting, setDeleting] = useState(false);
  // react-doctor-disable-next-line react-doctor/no-derived-state-effect -- slider progress is a user-editable draft, re-seeded only by confirmed server reading state; deriving it would discard unsaved input.
  useEffect(() => {
    // react-doctor-disable-next-line react-doctor/no-derived-state -- progress is an editable slider draft; synchronize only confirmed server changes, while preserving unsaved local movement until its change/blur action.
    setProgress(p.message.progress);
  }, [p.message.progress]);
  useEffect(() => {
    reader.current?.scrollIntoView?.({ block: "start" });
  }, [p.message.id]);
  return (
    <section
      ref={reader}
      className="edition-reader"
      aria-label="Newsletter reader"
    >
      <header className="edition-reader-toolbar">
        <button onClick={p.onClose}>← Back to library</button>
        <div>
          <button
            aria-label="Smaller reading text"
            onClick={() => setSize((s) => Math.max(16, s - 2))}
          >
            A−
          </button>
          <button
            aria-label="Larger reading text"
            onClick={() => setSize((s) => Math.min(28, s + 2))}
          >
            A+
          </button>
          <button
            disabled={p.busy}
            onClick={() => void p.onReading({ saved: !p.message.saved })}
          >
            {p.message.saved ? "Unsave edition" : "Save edition"}
          </button>
        </div>
      </header>
      <div className="edition-reading" style={{ fontSize: size }}>
        <span className="edition-eyebrow">{p.message.publication}</span>
        <h1>{p.message.subject}</h1>
        <div className="edition-byline">
          {editionDate(p.message.receivedAt)} ·{" "}
          {readingMinutes(p.message.text ?? p.message.excerpt)} min read
        </div>
        <details className="edition-source-details">
          <summary>From {p.message.sender}</summary>
          <p>
            {p.source?.email ?? "Source account unavailable"} ·{" "}
            {p.source?.scope === "work" ? "Work" : "Personal"}
          </p>
          <p>
            Remote email images are blocked. Source inbox read labels stay
            unchanged.
          </p>
        </details>
        {p.message.classification === "review" && (
          <div className="edition-review-note">
            <b>Does this belong in your reading library?</b>
            <p>This email needs a little human judgment.</p>
            <button
              disabled={p.busy || p.offline}
              onClick={() => void p.onCorrect("newsletter")}
            >
              Keep as newsletter
            </button>
            <button
              disabled={p.busy || p.offline}
              onClick={() => void p.onCorrect("other")}
            >
              Not a newsletter
            </button>
          </div>
        )}
        <div className="edition-article">
          {paragraphs.map((paragraph) => (
            <p key={paragraph.id}>{paragraph.text}</p>
          ))}
        </div>
        <ReadingActions
          p={p}
          progress={progress}
          setProgress={setProgress}
          setDeleting={setDeleting}
        />
      </div>
      {deleting && (
        <Dialog
          titleId="edition-delete-title"
          onClose={() => setDeleting(false)}
        >
          <h2 id="edition-delete-title">Remove this retained email?</h2>
          <p>
            “{p.message.subject}” will be removed from the shared archive on
            your Matrix computer and no longer be available to other authorized
            apps. Your source email is unchanged.
          </p>
          <button
            className="edition-primary"
            disabled={p.busy}
            onClick={() => void p.onDelete()}
          >
            Remove from Matrix
          </button>
          <button disabled={p.busy} onClick={() => setDeleting(false)}>
            Keep edition
          </button>
        </Dialog>
      )}
    </section>
  );
}

function ReadingActions({
  p,
  progress,
  setProgress,
  setDeleting,
}: {
  p: Props;
  progress: number;
  setProgress(next: number): void;
  setDeleting(next: boolean): void;
}) {
  return (
    <footer>
      <div className="edition-reading-progress">
        <label>
          Reading progress
          <input
            aria-label="Reading progress"
            type="range"
            min="0"
            max="100"
            value={Math.round(progress * 100)}
            onChange={(e) => setProgress(Number(e.target.value) / 100)}
            onPointerUp={() => void p.onReading({ progress })}
            onKeyUp={() => void p.onReading({ progress })}
          />
        </label>
        <span>{Math.round(progress * 100)}%</span>
      </div>
      <button
        disabled={p.busy}
        onClick={() =>
          void p.onReading({
            read: !p.message.read,
            progress: p.message.read ? 0 : 1,
          })
        }
      >
        {p.message.read ? "Mark unread" : "Mark as read"}
      </button>
      <button
        disabled={p.busy || !p.canDownload || p.downloaded || p.message.partial}
        onClick={() => void p.onDownload()}
      >
        {p.downloaded
          ? "Downloaded on this device"
          : "Download for offline reading"}
      </button>
      <button
        disabled={p.busy || !p.downloaded}
        onClick={() => void p.onRemoveDownload()}
      >
        Remove device download
      </button>
      <button
        disabled={p.busy || p.offline || p.preview}
        onClick={() => void p.onExport()}
      >
        Export retained email
      </button>
      <button
        disabled={p.busy || p.offline || p.preview}
        onClick={() => setDeleting(true)}
      >
        Remove retained email
      </button>
      <small>
        Offline copies can be removed on this device. Changes made elsewhere
        take effect after reconnecting.
      </small>
    </footer>
  );
}
