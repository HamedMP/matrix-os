import type { EditionView } from "./types";
const tabs: [EditionView, string, string][] = [
  ["library", "Library", "▦"],
  ["latest", "Latest", "◷"],
  ["unread", "Unread", "◌"],
  ["saved", "Saved", "⌑"],
  ["review", "Review", "◇"],
];
export default function EditionSidebar({
  view,
  count,
  sourceCount,
  disabled,
  onView,
  onSetup,
}: {
  view: EditionView;
  count: number;
  sourceCount: number;
  disabled: boolean;
  onView: (view: EditionView) => void;
  onSetup: () => void;
}) {
  return (
    <aside className="edition-sidebar">
      <div className="edition-brand">
        <div className="edition-logo" aria-hidden="true">
          E<span>✦</span>
        </div>
        <div>
          <b>Edition</b>
          <small>Good things, kept together.</small>
        </div>
      </div>
      <span className="edition-sidebar-label">YOUR READING ROOM</span>
      <nav aria-label="Reading collections">
        {tabs.map(([id, label, mark]) => (
          <button
            key={id}
            aria-current={view === id ? "page" : undefined}
            onClick={() => onView(id)}
          >
            <span aria-hidden="true">{mark}</span>
            {label}
            <small>{view === id ? count || "" : ""}</small>
          </button>
        ))}
      </nav>
      <div className="edition-sidebar-bottom">
        <div className="edition-source-mark">
          ✉
          <div>
            <b>
              {sourceCount} reading {sourceCount === 1 ? "source" : "sources"}
            </b>
            <small>Saved on your computer</small>
          </div>
        </div>
        <button disabled={disabled} onClick={() => onSetup()}>
          Manage email accounts <span>↗</span>
        </button>
      </div>
    </aside>
  );
}
