/** Engine-generated previews are explanations, never exact source spans. */
export function openVikingPreview(hit: {
  uri: string;
  content?: string | null;
  abstract?: string | null;
}): { text: string; provenance: "document" | "summary" } {
  // Matrix uploads precisely one note.md. Directory reads and hidden overview /
  // abstract files are OpenViking-generated content, even when read_content is set.
  const original =
    /\/r[1-9][0-9]*\/note\.md$/.test(hit.uri) && Boolean(hit.content);
  if (original) return { text: "", provenance: "document" };

  const generated = hit.content ?? hit.abstract ?? "";
  const withoutFrontmatter = generated.replace(
    /^\uFEFF?\s*---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/,
    "",
  );
  const text = withoutFrontmatter
    // These are service-side references, not user-facing citations. Canonical
    // Matrix source IDs and revision labels are added after authorization.
    .replace(/(?:viking|file):\/\/[^\s<>"'`()\[\]]+/gi, "[source]")
    .replace(
      /(?<![\w:/])\/(?:private\/)?(?:tmp|var|opt|home|root|run|Users)\/[^\s<>"'`()\[\]]+/g,
      "[source]",
    )
    .trim()
    .slice(0, 8000);
  return { text, provenance: "summary" };
}
