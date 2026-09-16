import { join, resolve } from "node:path";

export interface ManagedProjectSourceRecord {
  slug: string;
  kind?: "scratch" | "github" | "folder";
  localPath: string;
  legacyKindInferred?: true;
}

/**
 * Proves that a project record points at the Matrix-managed checkout layout.
 * A kind label alone is not authority to delete an owner-visible directory.
 */
export function isMatrixManagedProjectSource(
  homePath: string,
  project: ManagedProjectSourceRecord,
): boolean {
  if (
    (project.kind !== "scratch" && project.kind !== "github")
    || project.legacyKindInferred === true
  ) {
    return false;
  }
  return resolve(project.localPath) === join(resolve(homePath), "projects", project.slug, "repo");
}
