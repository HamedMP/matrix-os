import { useMemo, useState } from "react";
import { X } from "@renderer/lib/hugeicons";
import type { DesktopReleaseNotes } from "../../../../shared/desktop-update";
import type { ReleaseNotes, ReleaseNotesChannel } from "../../../../shared/release-notes";
import { Dialog } from "../../design/primitives";
import { diagnosticErrorKind } from "../../lib/errors";
import { invoke } from "../../lib/operator";
import { useDesktopUpdate } from "../../stores/desktop-update";
import { BUNDLED_RELEASE_NOTES, technicalReleaseNotesUrl, whatsNewEntries, type WhatsNewEntry } from "./release-notes-catalog";
import { whatsNewPreviewRequested } from "./whats-new-preview";
import { MarkdownReleaseBody, ReleaseHero, StructuredReleaseBody, tint } from "./WhatsNewRelease";


const CHANNELS: Record<ReleaseNotesChannel, { label: string; color: string }> = {
  dev: { label: "Dev", color: "var(--status-todo)" },
  canary: { label: "Canary", color: "var(--status-waiting)" },
  beta: { label: "Beta", color: "var(--status-running)" },
  stable: { label: "Stable", color: "var(--status-complete)" },
};

function formatDate(value: string | undefined, style: "long" | "short"): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return null;
  return new Intl.DateTimeFormat("en-US", {
    month: style,
    day: "numeric",
    ...(style === "long" ? { year: "numeric" } : {}),
    timeZone: "UTC",
  }).format(date);
}

function entryDate(entry: WhatsNewEntry): string | undefined {
  return entry.kind === "structured" ? entry.notes.date : entry.date;
}

function entryChannel(entry: WhatsNewEntry): ReleaseNotesChannel | null {
  return entry.kind === "structured" ? entry.notes.channel : null;
}

function ChannelChip({ channel }: { channel: ReleaseNotesChannel }) {
  const { label, color } = CHANNELS[channel];
  return (
    <span
      className="ml-1.5 inline-flex rounded-full px-[7px] py-px align-[1px] text-[10.5px] font-semibold"
      style={{ background: tint(color), color }}
    >
      {label}
    </span>
  );
}

function ReleaseRail({ entries, selected, onSelect }: {
  entries: readonly WhatsNewEntry[];
  selected: string;
  onSelect: (version: string) => void;
}) {
  return (
    <nav
      aria-label="Releases"
      className="hidden flex-col gap-0.5 overflow-y-auto border-r px-3 py-5 sm:flex"
      style={{ background: "var(--bg-surface)", borderColor: "var(--border-subtle)" }}
    >
      <h3
        className="mx-2.5 mt-1 mb-2.5 text-[11px] font-semibold tracking-[0.08em] uppercase"
        style={{ color: "var(--text-tertiary)", fontFamily: "inherit" }}
      >
        Releases
      </h3>
      {entries.map((entry) => {
        const current = entry.version === selected;
        const channel = entryChannel(entry);
        const date = formatDate(entryDate(entry), "short");
        const label = entry.kind === "structured"
          ? entry.notes.shortTitle ?? entry.notes.title
          : "Release notes";
        return (
          <button
            key={entry.version}
            type="button"
            aria-current={current ? "true" : undefined}
            onClick={() => onSelect(entry.version)}
            className="flex w-full flex-col items-start rounded-[9px] border px-2.5 py-[9px] text-left transition-colors hover:bg-[var(--bg-hover)]"
            style={{
              borderColor: current ? "var(--border-subtle)" : "transparent",
              background: current ? "var(--bg-overlay)" : undefined,
              boxShadow: current ? "var(--shadow-1)" : undefined,
            }}
          >
            <span className="text-[13px] font-semibold" style={{ color: "var(--text-primary)" }}>
              {entry.version}
              {channel ? <ChannelChip channel={channel} /> : null}
            </span>
            <span className="text-[11.5px]" style={{ color: "var(--text-tertiary)" }}>
              {date ? `${date} · ${label}` : label}
            </span>
          </button>
        );
      })}
    </nav>
  );
}

function ReleaseView({ entry, installedVersion, onClose }: {
  entry: WhatsNewEntry;
  installedVersion: string | null;
  onClose: () => void;
}) {
  const updated = entry.version === installedVersion;
  const date = formatDate(entryDate(entry), "long");
  const kicker = updated
    ? `Updated to ${entry.version}${date ? ` · ${date}` : ""}`
    : date ? `Released ${date}` : `Version ${entry.version}`;
  const notes = entry.kind === "structured" ? entry.notes : null;
  const channel = entryChannel(entry);

  const openTechnicalNotes = () => {
    void invoke("shell:open-external", {
      url: technicalReleaseNotesUrl(entry.version),
    }).catch((err: unknown) => {
      console.warn("[whats-new] could not open technical release notes:", diagnosticErrorKind(err));
    });
  };

  return (
    <>
      <ReleaseHero
        kicker={kicker}
        highlighted={updated}
        title={notes ? notes.title : `Matrix OS ${entry.version}`}
        {...(notes ? { lede: notes.summary } : {})}
      />
      {entry.kind === "structured" ? (
        <StructuredReleaseBody notes={entry.notes} />
      ) : (
        <MarkdownReleaseBody markdown={entry.markdown} />
      )}
      <footer
        className="mx-10 mt-2 mb-9 flex flex-wrap items-center gap-3.5 border-t pt-4 text-[12.5px]"
        style={{ borderColor: "var(--border-subtle)", color: "var(--text-tertiary)" }}
      >
        <button
          type="button"
          onClick={onClose}
          className="rounded-[9px] px-3.5 py-2 text-[13px] font-medium"
          style={{ background: "var(--accent)", color: "var(--text-on-accent)" }}
        >
          Got it
        </button>
        <button
          type="button"
          onClick={openTechnicalNotes}
          className="border-b"
          style={{ color: "var(--text-secondary)", borderColor: "var(--border-default)" }}
        >
          Technical release notes ↗
        </button>
        {channel ? <span className="ml-auto">{CHANNELS[channel].label} channel</span> : null}
      </footer>
    </>
  );
}

function WhatsNewContent({ entries, installedVersion, onClose }: {
  entries: readonly WhatsNewEntry[];
  installedVersion: string | null;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState(() => installedVersion ?? entries[0]?.version ?? "");
  const entry = entries.find((candidate) => candidate.version === selected) ?? entries[0];

  return (
    <div
      className="grid grid-cols-1 overflow-hidden rounded-[inherit] [--wn-art-mix:100%] [--wn-wash-mix:55%] sm:grid-cols-[220px_1fr] [[data-theme=dark]_&]:[--wn-art-mix:30%] [[data-theme=dark]_&]:[--wn-wash-mix:16%] [[data-theme=dark]_&]:[--wn-art-card:#302e2c] [[data-theme=dark]_&]:[--wn-art-line:#4a4744] [[data-theme=dark]_&]:[--wn-art-ink:#f2f0ec] [[data-theme=dark]_&]:[--wn-art-muted:#9b978f]"
      style={{ height: "min(86vh, 820px)" }}
    >
      <ReleaseRail entries={entries} selected={entry?.version ?? ""} onSelect={setSelected} />
      <div className="relative min-h-0 overflow-y-auto" data-selectable>
        <button
          type="button"
          aria-label="Close What's New"
          className="absolute top-4 right-4 z-[2] flex h-[30px] w-[30px] items-center justify-center rounded-lg transition-colors hover:bg-[var(--bg-hover)]"
          style={{ color: "var(--text-tertiary)" }}
          onClick={onClose}
        >
          <X size={16} />
        </button>
        {entry ? (
          <ReleaseView entry={entry} installedVersion={installedVersion} onClose={onClose} />
        ) : (
          <ReleaseHero
            kicker="Release notes"
            highlighted={false}
            title="No release notes yet"
            lede="Notes for future updates will show up here."
          />
        )}
      </div>
    </div>
  );
}

export default function WhatsNewDialog({ catalog = BUNDLED_RELEASE_NOTES }: {
  catalog?: readonly ReleaseNotes[];
}) {
  const open = useDesktopUpdate(
    (state) => state.whatsNewOpen && !state.manualDialogOpen,
  );
  const release: DesktopReleaseNotes | null = useDesktopUpdate((state) => state.release);
  const installedChannel = useDesktopUpdate((state) => state.buildChannel);
  // Dev preview reviews every channel's notes; local dev builds report "stable".
  const buildChannel = whatsNewPreviewRequested() ? "dev" : installedChannel;
  const close = useDesktopUpdate((state) => state.closeWhatsNew);
  const entries = useMemo(
    () => whatsNewEntries(catalog, release, buildChannel),
    [catalog, release, buildChannel],
  );

  return (
    <Dialog open={open} onClose={close} width={1120} title="What's New" top="6vh">
      <WhatsNewContent entries={entries} installedVersion={release?.version ?? null} onClose={close} />
    </Dialog>
  );
}
