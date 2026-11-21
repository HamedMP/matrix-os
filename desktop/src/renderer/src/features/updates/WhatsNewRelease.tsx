import type {
  ReleaseNotes,
  ReleaseNotesHighlight,
  ReleaseNotesItem,
  ReleaseNotesSurface,
} from "../../../../shared/release-notes";
import { resolveHighlightArt } from "./highlight-art";
import { releaseNotesMediaUrl } from "./release-notes-catalog";
import { HERO_WASH, HighlightArt } from "./WhatsNewArt";
import ReleaseNotesMarkdown from "./ReleaseNotesMarkdown";

const SURFACE_LABELS: Record<ReleaseNotesSurface, string> = {
  "web-desktop": "Web Desktop",
  "web-canvas": "Web Canvas",
  "electron-desktop": "Desktop app",
  "web-mobile": "Mobile web",
  "native-mobile": "Mobile app",
};

const ITEM_PILLS: Record<ReleaseNotesItem["kind"], { label: string; color: string }> = {
  new: { label: "New", color: "var(--highlight)" },
  improved: { label: "Improved", color: "var(--status-running)" },
  fixed: { label: "Fixed", color: "var(--status-waiting)" },
};

export function tint(color: string): string {
  return `color-mix(in srgb, ${color} 14%, transparent)`;
}

export function ReleaseHero({ kicker, highlighted, title, lede }: {
  kicker: string;
  highlighted: boolean;
  title: string;
  lede?: string;
}) {
  return (
    <header className="px-10 pt-9 pb-2" style={{ background: HERO_WASH }}>
      <div className="flex items-center gap-2 text-[12.5px]" style={{ color: "var(--text-tertiary)" }}>
        {highlighted ? (
          <span aria-hidden="true" className="h-[7px] w-[7px] rounded-full" style={{ background: "var(--highlight)" }} />
        ) : null}
        <span>{kicker}</span>
      </div>
      <h2
        className="mt-2.5 mb-2 text-[34px] leading-[1.08] font-bold tracking-tight"
        style={{ color: "var(--text-primary)" }}
      >
        {title}
      </h2>
      {lede ? (
        <p className="m-0 max-w-[560px] text-[15px] leading-6" style={{ color: "var(--text-secondary)" }}>
          {lede}
        </p>
      ) : null}
    </header>
  );
}

function HighlightCard({ highlight, index, large }: {
  highlight: ReleaseNotesHighlight;
  index: number;
  large: boolean;
}) {
  const media = releaseNotesMediaUrl(highlight.media);
  const { art, tone } = resolveHighlightArt(highlight, index);
  return (
    <article
      className="overflow-hidden rounded-[14px] border"
      style={{ borderColor: "var(--border-subtle)", background: "var(--bg-overlay)" }}
    >
      {media ? (
        <img
          src={media}
          alt=""
          className={`block w-full object-cover ${large ? "h-[200px]" : "h-[140px]"}`}
          style={{ background: "var(--bg-surface)" }}
        />
      ) : (
        <HighlightArt art={art} tone={tone} large={large} />
      )}
      <div className="px-5 pt-[18px] pb-5">
        {highlight.tag ? (
          <div className="text-[11px] font-semibold tracking-[0.04em] uppercase" style={{ color: "var(--highlight)" }}>
            {highlight.tag}
          </div>
        ) : null}
        <h3
          className="mt-1 mb-1.5 text-lg font-semibold"
          style={{ color: "var(--text-primary)", fontFamily: "inherit" }}
        >
          {highlight.title}
        </h3>
        <p className="m-0 text-sm leading-6" style={{ color: "var(--text-secondary)" }}>
          {highlight.body}
        </p>
        {highlight.surfaces && highlight.surfaces.length > 0 ? (
          <ul aria-label="Available on" className="mt-2.5 flex list-none flex-wrap gap-1.5 p-0">
            {highlight.surfaces.map((surface) => (
              <li
                key={surface}
                className="rounded-full border px-2 py-0.5 text-[11.5px]"
                style={{
                  borderColor: "var(--border-subtle)",
                  background: "var(--bg-surface)",
                  color: "var(--text-secondary)",
                }}
              >
                {SURFACE_LABELS[surface]}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </article>
  );
}

export function StructuredReleaseBody({ notes }: { notes: ReleaseNotes }) {
  const [lead, ...rest] = notes.highlights;
  return (
    <>
      {lead ? (
        <div className="mx-10 mt-[26px]">
          <HighlightCard highlight={lead} index={0} large />
        </div>
      ) : null}
      {rest.length > 0 ? (
        <div className="mx-10 mt-3.5 grid grid-cols-1 gap-3.5 sm:grid-cols-2">
          {rest.map((highlight, index) => (
            <HighlightCard key={highlight.title} highlight={highlight} index={index + 1} large={false} />
          ))}
        </div>
      ) : null}
      {notes.items.length > 0 ? (
        <section aria-labelledby="whats-new-also" className="mx-10 mt-7">
          <h4 id="whats-new-also" className="mb-2 text-[13px] font-semibold" style={{ color: "var(--text-primary)" }}>
            Also in this release
          </h4>
          <ul className="m-0 mb-[18px] list-none p-0">
            {notes.items.map((item, index) => {
              const pill = ITEM_PILLS[item.kind];
              return (
                <li
                  key={`${item.kind}-${item.text}`}
                  className={`flex gap-2.5 py-[7px] text-[13.5px] ${index === 0 ? "" : "border-t"}`}
                  style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}
                >
                  <span
                    className="mt-0.5 h-[18px] flex-none rounded-[5px] px-[7px] text-[10.5px] leading-[16px] font-semibold"
                    style={{ background: tint(pill.color), color: pill.color }}
                  >
                    {pill.label}
                  </span>
                  {item.text}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </>
  );
}

export function MarkdownReleaseBody({ markdown }: { markdown: string }) {
  return (
    <div
      data-selectable
      className="mx-10 mt-6 text-sm leading-6 [&_a]:font-medium [&_a]:text-[var(--accent)] [&_code]:rounded [&_code]:bg-[var(--bg-sunken)] [&_code]:px-1 [&_h1]:mt-6 [&_h1]:mb-3 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:mt-6 [&_h2]:mb-3 [&_h2]:text-base [&_h2]:font-semibold [&_h3]:mt-5 [&_h3]:mb-2 [&_h3]:font-semibold [&_li]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_ul]:list-disc [&_ul]:pl-5"
      style={{ color: "var(--text-secondary)" }}
    >
      <ReleaseNotesMarkdown notes={markdown} />
    </div>
  );
}
