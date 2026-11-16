// Structured, user-facing release notes (release-notes/<version>.json).
// Kept dependency-free apart from Zod and limited to erasable TypeScript so
// both the renderer bundle and `node scripts/release-notes/validate.mjs` can
// import it directly.
import { z } from "zod/v4";

export const MAX_RELEASE_NOTES_HIGHLIGHTS = 4;
export const MAX_RELEASE_NOTES_ITEMS = 30;
export const MAX_RELEASE_NOTES_HIDDEN = 300;

const RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
// A bare file name inside release-notes/media/. No URLs, paths or SVG.
const RELEASE_MEDIA_PATTERN = /^[a-z0-9][a-z0-9._-]{0,94}\.(?:webp|png|jpe?g|avif)$/i;

export const RELEASE_NOTES_CHANNELS = ["dev", "canary", "beta", "stable"] as const;
export const RELEASE_NOTES_SURFACES = [
  "web-desktop",
  "web-canvas",
  "electron-desktop",
  "web-mobile",
  "native-mobile",
] as const;
export const RELEASE_NOTES_ITEM_KINDS = ["new", "improved", "fixed"] as const;
// Built-in illustrations and gradient tones for highlight cards. A bundled
// `media` image, when present, wins over the illustration.
export const RELEASE_NOTES_ART = ["agents", "terminal", "notification", "sparkle", "shield", "sync"] as const;
export const RELEASE_NOTES_TONES = ["lime", "teal", "sand", "ink"] as const;

const text = (max: number) => z.string().trim().min(1).max(max);

export const ReleaseNotesHighlightSchema = z.strictObject({
  title: text(80),
  body: text(400),
  tag: text(24).optional(),
  surfaces: z
    .array(z.enum(RELEASE_NOTES_SURFACES))
    .max(RELEASE_NOTES_SURFACES.length)
    .refine((surfaces) => new Set(surfaces).size === surfaces.length, "surfaces must be unique")
    .optional(),
  media: z.string().regex(RELEASE_MEDIA_PATTERN).optional(),
  art: z.enum(RELEASE_NOTES_ART).optional(),
  tone: z.enum(RELEASE_NOTES_TONES).optional(),
  prs: z.array(z.number().int().positive()).max(50).optional(),
});

export const ReleaseNotesItemSchema = z.strictObject({
  kind: z.enum(RELEASE_NOTES_ITEM_KINDS),
  text: text(200),
});

export const ReleaseNotesSchema = z.strictObject({
  version: z.string().max(64).regex(RELEASE_VERSION_PATTERN),
  channel: z.enum(RELEASE_NOTES_CHANNELS),
  date: z.union([z.iso.date(), z.iso.datetime()]),
  title: text(80),
  // Short label for the history rail; falls back to `title`.
  shortTitle: text(40).optional(),
  summary: text(400),
  // Translations are future work: one file per version, English only for now.
  locale: z.string().regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/).default("en"),
  highlights: z.array(ReleaseNotesHighlightSchema).max(MAX_RELEASE_NOTES_HIGHLIGHTS),
  items: z.array(ReleaseNotesItemSchema).max(MAX_RELEASE_NOTES_ITEMS),
  // Audit trail of PR numbers deliberately left out of the user-facing notes.
  hidden: z.array(z.number().int().positive()).max(MAX_RELEASE_NOTES_HIDDEN).optional(),
});

export type ReleaseNotes = z.infer<typeof ReleaseNotesSchema>;
export type ReleaseNotesHighlight = z.infer<typeof ReleaseNotesHighlightSchema>;
export type ReleaseNotesItem = z.infer<typeof ReleaseNotesItemSchema>;
export type ReleaseNotesSurface = (typeof RELEASE_NOTES_SURFACES)[number];
export type ReleaseNotesChannel = (typeof RELEASE_NOTES_CHANNELS)[number];
export type ReleaseNotesArt = (typeof RELEASE_NOTES_ART)[number];
export type ReleaseNotesTone = (typeof RELEASE_NOTES_TONES)[number];

function versionParts(version: string): { core: number[]; pre: string | null } {
  const [withoutBuild = ""] = version.split("+");
  const dash = withoutBuild.indexOf("-");
  const core = (dash === -1 ? withoutBuild : withoutBuild.slice(0, dash)).split(".").map(Number);
  return { core, pre: dash === -1 ? null : withoutBuild.slice(dash + 1) };
}

/** SemVer precedence for release versions: >0 when `a` is newer than `b`. */
export function compareReleaseVersions(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let index = 0; index < 3; index += 1) {
    const diff = (left.core[index] ?? 0) - (right.core[index] ?? 0);
    if (diff !== 0) return diff;
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === null) return 1;
  if (right.pre === null) return -1;
  return left.pre.localeCompare(right.pre, "en", { numeric: true });
}
