import type { GalleryAppListing } from "./model";
export function Glyph({ view, size = 24 }: { view: string; size?: number }) {
  const paths: Record<string, string> = {
    finance: "M5 3h14v18H5z M8 7h8 M8 11h3 M8 15h8",
    travel: "M3 17 21 7 14 21 11 14 3 17 M11 14 21 7",
    agenda: "M4 6h16v15H4z M8 3v6 M16 3v6 M4 11h16 M8 15h2 M14 15h2",
    board: "M3 4h5v16H3z M10 4h5v11h-5z M17 4h4v7h-4z",
    library: "M3 5h7l2 2 2-2h7v15h-7l-2 2-2-2H3z M12 7v15",
    notes: "M5 3h14v18H5z M8 7h8 M8 11h8 M8 15h5",
    habits: "M12 21V10 M12 15C3 15 3 7 3 7s9 0 9 8 M12 10c0-8 9-8 9-8s0 8-9 8",
    focus: "M12 3a9 9 0 1 0 9 9 M12 7v5l3 2 M17 3h4v4",
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[view] ?? paths.notes} />
    </svg>
  );
}
export function Icon({
  name,
}: {
  name: "search" | "close" | "arrow" | "check" | "refresh" | "grid";
}) {
  const paths = {
    search: "M21 21l-5-5 M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16",
    close: "M6 6l12 12 M18 6 6 18",
    arrow: "M5 12h14 M14 7l5 5-5 5",
    check: "m5 12 4 4 10-10",
    refresh: "M20 7a9 9 0 1 0 1 9 M20 3v5h-5",
    grid: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  };
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
export default function Preview({
  app,
  large = false,
}: {
  app: GalleryAppListing;
  large?: boolean;
}) {
  const boardLabels = app.fields
    .find((field) => field.kind === "select")
    ?.options?.slice(0, 3) ?? ["Plan", "In progress", "Done"];
  return (
    <div
      className={`preview preview-view-${app.view} ${large ? "preview-large" : ""}`}
      aria-label={`Illustration of ${app.name}`}
      role="img"
    >
      <div className="preview-window">
        <div className="preview-rail">
          <span />
          <span />
          <span />
          <div />
          <div />
        </div>
        <div className="preview-content">
          <div className="preview-heading">
            <span />
            <i />
          </div>
          {app.view === "finance" && (
            <>
              <div className="preview-finance-top">
                <span />
                <span />
                <span />
              </div>
              <svg
                className="preview-chart"
                viewBox="0 0 280 94"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M0 24h280M0 54h280M0 84h280"
                  stroke="currentColor"
                  opacity=".12"
                />
                <path
                  d="M0 76C22 76 22 55 45 57S75 70 94 48s35 18 57-4 36 12 57-13 42 3 72-24V94H0Z"
                  fill="currentColor"
                  opacity=".1"
                />
                <path
                  d="M0 76C22 76 22 55 45 57S75 70 94 48s35 18 57-4 36 12 57-13 42 3 72-24"
                  stroke="currentColor"
                  strokeWidth="2.5"
                />
              </svg>
              <div className="preview-rows">
                {[1, 2, 3].map((i) => (
                  <div key={i}>
                    <i />
                    <span />
                    <b />
                  </div>
                ))}
              </div>
            </>
          )}
          {app.view === "travel" && (
            <svg
              className="preview-map"
              viewBox="0 0 300 170"
              aria-hidden="true"
            >
              <path
                d="m19 35 28-16 30 9 22 25-15 13 4 19-25 20-11-20-20-4Zm70 73 26 1 18 31-19 27-17-24Zm52-64 29-17 31 14 20-10 34 25-13 26-36 1-22-11-29 12-27-22Zm25 41 35 8 11 30-23 33-15-20-9-26Zm70 48 29-3 16 18-24 11-22-10Z"
                fill="currentColor"
                opacity=".12"
              />
              <path
                d="M60 64Q128 0 177 58T247 74"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeDasharray="4 5"
              />
              {[
                [60, 64],
                [177, 58],
                [247, 74],
              ].map(([cx, cy]) => (
                <g key={cx}>
                  <circle
                    cx={cx}
                    cy={cy}
                    r="7"
                    fill="currentColor"
                    opacity=".14"
                  />
                  <circle cx={cx} cy={cy} r="3" fill="currentColor" />
                </g>
              ))}
            </svg>
          )}
          {app.view === "agenda" && (
            <div className="preview-agenda">
              <div className="agenda-grid">
                {Array.from({ length: 28 }, (_, i) => (
                  <span
                    className={i === 10 || i === 16 || i === 23 ? "marked" : ""}
                    key={i}
                  />
                ))}
              </div>
              <div className="agenda-lines">
                <i />
                <span />
                <i />
                <span />
                <i />
                <span />
              </div>
            </div>
          )}
          {app.view === "board" && (
            <div className="preview-board">
              {boardLabels.map((label, i) => (
                <div key={label}>
                  <small>{label}</small>
                  {Array.from({ length: 3 - (i % 2) }, (_, n) => (
                    <span key={n}>
                      <i />
                      <i />
                      <b />
                    </span>
                  ))}
                </div>
              ))}
            </div>
          )}
          {app.view === "library" && (
            <div className="preview-library">
              {app.fields.slice(0, 4).map((field, i) => (
                <div key={field.key}>
                  <span className={`book-cover book-${i}`}>
                    <Glyph view={i % 2 ? "notes" : "library"} size={28} />
                  </span>
                  <i />
                  <b />
                </div>
              ))}
            </div>
          )}
          {app.view === "notes" && (
            <div className="preview-note">
              <div className="note-title" />
              <div />
              <div />
              <div className="note-short" />
              <blockquote />
              <div />
              <div className="note-short" />
            </div>
          )}
          {app.view === "habits" && (
            <div className="preview-habits">
              <div className="habit-tree">
                <Glyph view="habits" size={70} />
              </div>
              <div className="habit-grid">
                {Array.from({ length: 28 }, (_, i) => (
                  <span className={i % 5 === 0 ? "rest" : "filled"} key={i} />
                ))}
              </div>
            </div>
          )}
          {app.view === "focus" && (
            <div className="preview-focus">
              <svg viewBox="0 0 120 120" aria-hidden="true">
                <circle
                  cx="60"
                  cy="60"
                  r="44"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="4"
                  opacity=".12"
                />
                <circle
                  cx="60"
                  cy="60"
                  r="44"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="4"
                  strokeDasharray="195 277"
                  transform="rotate(-90 60 60)"
                  strokeLinecap="round"
                />
              </svg>
              <div className="focus-center">
                <Glyph view="focus" size={35} />
              </div>
              <div className="focus-line" />
            </div>
          )}
        </div>
      </div>
      <span className="illustration-label">Illustrative preview</span>
    </div>
  );
}
