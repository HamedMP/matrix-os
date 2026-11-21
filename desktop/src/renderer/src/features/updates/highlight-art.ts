import type {
  ReleaseNotesArt,
  ReleaseNotesHighlight,
  ReleaseNotesTone,
} from "../../../../shared/release-notes";

// Generic illustrations first, so an unannotated highlight never claims a
// specific feature it is not about.
const FALLBACK_ART: readonly ReleaseNotesArt[] = ["sparkle", "sync", "shield", "agents", "terminal", "notification"];
const FALLBACK_TONES: readonly ReleaseNotesTone[] = ["lime", "teal", "sand", "ink"];

/** The card's illustration and tone: explicit values win, else by position. */
export function resolveHighlightArt(
  highlight: Pick<ReleaseNotesHighlight, "art" | "tone">,
  index: number,
): { art: ReleaseNotesArt; tone: ReleaseNotesTone } {
  const position = Math.max(0, Math.trunc(index));
  return {
    art: highlight.art ?? FALLBACK_ART[position % FALLBACK_ART.length] ?? "sparkle",
    tone: highlight.tone ?? FALLBACK_TONES[position % FALLBACK_TONES.length] ?? "lime",
  };
}
