// Spec 537: the same-repository PR a host bundle was built from, so a Private
// Preview owner can confirm exactly that PR's code. Mirrors the platform's
// registration schema so a bad value fails here, before anything uploads.
const SOURCE_PR_PATTERN = /^[1-9][0-9]{0,8}$/;
const SOURCE_AUTHOR_PATTERN = /^[A-Za-z0-9-]{1,39}$/;

export function parseReleaseProvenance({ sourcePr, sourceAuthor } = {}) {
  const provenance = {};
  if (sourcePr !== undefined && sourcePr !== "") {
    if (!SOURCE_PR_PATTERN.test(sourcePr)) throw new Error("--source-pr must be a pull request number");
    provenance.sourcePr = Number(sourcePr);
  }
  if (sourceAuthor !== undefined && sourceAuthor !== "") {
    if (!SOURCE_AUTHOR_PATTERN.test(sourceAuthor)) throw new Error("--source-author must be a GitHub login");
    provenance.sourceAuthor = sourceAuthor;
  }
  return provenance;
}
