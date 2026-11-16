import type { DesktopReleaseNotes } from "../../../../shared/desktop-update";
import {
  ReleaseNotesSchema,
  compareReleaseVersions,
  type ReleaseNotes,
  type ReleaseNotesChannel,
} from "../../../../shared/release-notes";

export type WhatsNewEntry =
  | { kind: "structured"; version: string; notes: ReleaseNotes }
  | { kind: "markdown"; version: string; date?: string; markdown: string };

type Warn = (message: string, detail: string) => void;

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function timestamp(date: string | undefined): number | null {
  if (!date) return null;
  const value = Date.parse(date);
  return Number.isNaN(value) ? null : value;
}

// Newest first by release date, then by version. Canary builds keep an old
// base version (0.1.24-canary.<build> ships after 0.1.29), so the version
// alone cannot order history. An entry without a date is the update that was
// just installed, so it leads.
function compareNewestFirst(
  a: { version: string; date?: string },
  b: { version: string; date?: string },
): number {
  const left = timestamp(a.date);
  const right = timestamp(b.date);
  if (left === null && right !== null) return -1;
  if (right === null && left !== null) return 1;
  if (left !== null && right !== null && left !== right) return right - left;
  return compareReleaseVersions(b.version, a.version);
}

/**
 * Notes for an installed version. An exact file wins; otherwise a channel
 * entry such as `0.1.24-canary` covers every build `0.1.24-canary.<stamp>`,
 * because canary build stamps are not known when the notes are written.
 */
export function releaseNotesForVersion(
  catalog: readonly ReleaseNotes[],
  version: string,
): ReleaseNotes | null {
  const exact = catalog.find((notes) => notes.version === version);
  if (exact) return exact;
  return catalog.find((notes) => notes.version.includes("-") && version.startsWith(`${notes.version}.`)) ?? null;
}

/** Validates bundled release-notes modules; invalid files are logged and skipped. */
export function buildReleaseNotesCatalog(
  modules: Record<string, unknown>,
  warn: Warn = console.warn,
): ReleaseNotes[] {
  const byVersion = new Map<string, ReleaseNotes>();
  for (const [path, value] of Object.entries(modules)) {
    const parsed = ReleaseNotesSchema.safeParse(value);
    if (!parsed.success) {
      warn("[whats-new] skipped invalid release notes:", fileName(path));
      continue;
    }
    if (byVersion.has(parsed.data.version)) {
      warn("[whats-new] skipped duplicate release notes:", fileName(path));
      continue;
    }
    byVersion.set(parsed.data.version, parsed.data);
  }
  return [...byVersion.values()].sort(compareNewestFirst);
}

// Most stable first. A build lists entries from its own channel and from
// more stable ones, never notes from a less stable channel.
const CHANNEL_RANK: Record<ReleaseNotesChannel, number> = { stable: 0, beta: 1, canary: 2, dev: 3 };

function channelOfVersion(version: string): ReleaseNotesChannel {
  const prerelease = /^\d+\.\d+\.\d+-([0-9A-Za-z]+)/.exec(version)?.[1];
  return prerelease === "beta" || prerelease === "canary" || prerelease === "dev" ? prerelease : "stable";
}

/**
 * History shown in What's New, newest first. An installed update without
 * structured notes keeps its markdown release body as its own entry.
 */
export function whatsNewEntries(
  catalog: readonly ReleaseNotes[],
  release: DesktopReleaseNotes | null,
  // The running build's channel; when unknown, the installed version decides,
  // and with neither every entry is listed.
  buildChannel: ReleaseNotesChannel | null = null,
): WhatsNewEntry[] {
  const installed = release ? releaseNotesForVersion(catalog, release.version) : null;
  const channel = buildChannel ?? (release ? channelOfVersion(release.version) : null);
  const visible = channel === null
    ? catalog
    : catalog.filter((notes) => notes === installed || CHANNEL_RANK[notes.channel] <= CHANNEL_RANK[channel]);
  const entries: WhatsNewEntry[] = visible.map((notes) => ({
    kind: "structured",
    // A channel entry takes the installed build's version so the dialog can
    // select it and mark it as the update that was just installed.
    version: release && notes === installed ? release.version : notes.version,
    notes,
  }));
  if (release && !installed) {
    entries.push({
      kind: "markdown",
      version: release.version,
      ...(release.releaseDate ? { date: release.releaseDate } : {}),
      markdown: release.notes,
    });
  }
  return entries.sort((a, b) =>
    compareNewestFirst(
      { version: a.version, date: a.kind === "structured" ? a.notes.date : a.date },
      { version: b.version, date: b.kind === "structured" ? b.notes.date : b.date },
    ),
  );
}

// Release notes are bundled at build time so What's New works offline and for
// every past release, not only the one that was just installed.
export const BUNDLED_RELEASE_NOTES: readonly ReleaseNotes[] = buildReleaseNotesCatalog(
  import.meta.glob("../../../../../../release-notes/*.json", { eager: true, import: "default" }),
);

const BUNDLED_MEDIA: Record<string, string> = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>("../../../../../../release-notes/media/*.{webp,png,jpg,jpeg,avif}", {
      eager: true,
      query: "?url",
      import: "default",
    }),
  ).map(([path, url]) => [fileName(path), url]),
);

export function releaseNotesMediaUrl(media: string | undefined): string | null {
  if (!media) return null;
  return BUNDLED_MEDIA[media] ?? null;
}
