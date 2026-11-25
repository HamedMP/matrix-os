import { join } from "node:path";
import { APP_FILES_PERMISSION } from "@matrix-os/contracts/app-files";
import { readBoundedJsonFileWithIdentity } from "../bounded-json-file.js";
import { listUniqueAppManifests, MAX_APP_MANIFEST_BYTES } from "../app-runtime/app-index.js";
import { AppManifestSchema } from "../app-runtime/manifest-schema.js";

function hasImportedProvenance(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.hasOwn(value, "installed_from") || Object.hasOwn(value, "forked_from"));
}

/**
 * True only when `app` names exactly one installed manifest that is
 * first-party, personal, not hidden, not imported or forked, and declares the
 * `files` permission. The manifest is re-read on every request, so a trust or
 * permission downgrade takes effect immediately even while the app index is
 * cached. Same resolution rules as the app capability policy.
 */
export async function appFilesAllowed(homePath: string, app: string): Promise<boolean> {
  const manifests = await listUniqueAppManifests(join(homePath, "apps"));
  const candidates = manifests.filter((candidate) => candidate.relativePath === app || candidate.slug === app);
  let allowed = 0;
  let matches = 0;
  for (const candidate of candidates) {
    const document = await readBoundedJsonFileWithIdentity(candidate.manifestPath, MAX_APP_MANIFEST_BYTES);
    if (!document) continue;
    const parsed = AppManifestSchema.safeParse(document.value);
    if (!parsed.success || (candidate.relativePath !== app && parsed.data.slug !== app)) continue;
    matches++;
    const manifest = parsed.data;
    if (hasImportedProvenance(document.value)) continue;
    if (manifest.listingTrust !== "first_party" || manifest.scope !== "personal" || manifest.hidden) continue;
    if (!manifest.permissions.includes(APP_FILES_PERMISSION)) continue;
    allowed++;
  }
  return matches === 1 && allowed === 1;
}
