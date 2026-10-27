import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import { AppIdentitySchema } from "@matrix-os/contracts";
import { readBoundedJsonFileWithIdentity } from "../bounded-json-file.js";
import { listUniqueAppManifests } from "../app-runtime/app-index.js";
import { AppManifestSchema, type AppManifest } from "../app-runtime/manifest-schema.js";

const Name = z.string().min(1).max(128).regex(/^[a-z][a-z0-9_-]*$/);
export const AppCapabilityPolicySchema = z.strictObject({
  apps: z.record(AppIdentitySchema, z.strictObject({
    services: z.record(Name, z.array(Name).min(1).max(128)).refine(value => Object.keys(value).length <= 100),
  })).refine(value => Object.keys(value).length <= 100),
});
export type AppCapabilityGrant = z.infer<typeof AppCapabilityPolicySchema>["apps"][string];
export type AppCapabilityAccess =
  | { kind: "policy"; grant: AppCapabilityGrant }
  | { kind: "trusted-default" };
const MAX_APP_MANIFEST_BYTES = 1024 * 1024;

/** Read optional owner restrictions/explicit grants on every request. */
export async function readAppCapabilityGrant(homePath: string, app: string): Promise<AppCapabilityGrant | null> {
  const path = join(homePath, "system/app-capabilities.json");
  try {
    await lstat(path);
  } catch (error: unknown) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const document = await readBoundedJsonFileWithIdentity(path, 65_536);
  if (!document) throw new Error("Invalid app capability policy");
  return AppCapabilityPolicySchema.parse(document.value).apps[app] ?? null;
}

/**
 * Owner policy is an explicit restriction/override. Without one, only an
 * owner-built first-party personal app inherits the owner's live integration
 * catalog. Imported/community apps continue to fail closed.
 */
export async function readAppCapabilityAccess(homePath: string, app: string): Promise<AppCapabilityAccess | null> {
  const grant = await readAppCapabilityGrant(homePath, app);
  if (grant) return { kind: "policy", grant };
  const manifests = await listUniqueAppManifests(join(homePath, "apps"));
  const candidates = manifests.filter(candidate => candidate.relativePath === app || candidate.slug === app);
  const matches: AppManifest[] = [];
  for (const candidate of candidates) {
    // The index is bounded and briefly cached for discovery. Authorization
    // always re-reads the exact manifest so a trust downgrade takes effect
    // before a provider action, even while the discovery cache is warm.
    const document = await readBoundedJsonFileWithIdentity(candidate.manifestPath, MAX_APP_MANIFEST_BYTES);
    if (!document) continue;
    const parsed = AppManifestSchema.safeParse(document.value);
    if (!parsed.success || (candidate.relativePath !== app && parsed.data.slug !== app)) continue;
    matches.push(parsed.data);
  }
  if (matches.length !== 1) return null;
  const manifest = matches[0]!;
  if (manifest.listingTrust !== "first_party" || manifest.scope !== "personal" || manifest.hidden) return null;
  return { kind: "trusted-default" };
}

export function appCapabilityServiceAllowed(access: AppCapabilityAccess | null, service: string): boolean {
  return access?.kind === "trusted-default" || Boolean(access?.grant.services[service]);
}

export function appCapabilityActionAllowed(access: AppCapabilityAccess | null, service: string, action: string): boolean {
  return access?.kind === "trusted-default" || Boolean(access?.grant.services[service]?.includes(action));
}

export function appCapabilityIntegrationsAvailable(access: AppCapabilityAccess | null): boolean {
  return access?.kind === "trusted-default" || Boolean(access && Object.keys(access.grant.services).length);
}
