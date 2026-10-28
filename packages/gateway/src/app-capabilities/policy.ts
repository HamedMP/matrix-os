import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import { AppIdentitySchema } from "@matrix-os/contracts";
import { readBoundedJsonFileWithIdentity } from "../bounded-json-file.js";
import { listUniqueAppManifests, MAX_APP_MANIFEST_BYTES } from "../app-runtime/app-index.js";
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

async function readAppCapabilityPolicy(homePath: string): Promise<z.infer<typeof AppCapabilityPolicySchema> | null> {
  const path = join(homePath, "system/app-capabilities.json");
  try {
    await lstat(path);
  } catch (error: unknown) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const document = await readBoundedJsonFileWithIdentity(path, 65_536);
  if (!document) throw new Error("Invalid app capability policy");
  return AppCapabilityPolicySchema.parse(document.value);
}

function intersectGrants(grants: AppCapabilityGrant[]): AppCapabilityGrant {
  const [first, ...rest] = grants;
  if (!first) return { services: {} };
  const services = Object.fromEntries(Object.entries(first.services).flatMap(([service, actions]) => {
    const common = actions.filter(action => rest.every(grant => grant.services[service]?.includes(action)));
    return common.length > 0 ? [[service, common]] : [];
  }));
  return { services };
}

function hasImportedProvenance(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.hasOwn(value, "installed_from") || Object.hasOwn(value, "forked_from"));
}

/** Read optional owner restrictions/explicit grants on every request. */
export async function readAppCapabilityGrant(homePath: string, app: string): Promise<AppCapabilityGrant | null> {
  return (await readAppCapabilityPolicy(homePath))?.apps[app] ?? null;
}

/**
 * Owner policy is an explicit restriction/override. Without one, only an
 * owner-built first-party personal app inherits the owner's live integration
 * catalog. Imported/community apps continue to fail closed.
 */
export async function readAppCapabilityAccess(homePath: string, app: string): Promise<AppCapabilityAccess | null> {
  const policy = await readAppCapabilityPolicy(homePath);
  const manifests = await listUniqueAppManifests(join(homePath, "apps"));
  const candidates = manifests.filter(candidate => candidate.relativePath === app || candidate.slug === app);
  const matches: Array<{ manifest: AppManifest; relativePath: string; imported: boolean }> = [];
  for (const candidate of candidates) {
    // The index is bounded and briefly cached for discovery. Authorization
    // always re-reads the exact manifest so a trust downgrade takes effect
    // before a provider action, even while the discovery cache is warm.
    const document = await readBoundedJsonFileWithIdentity(candidate.manifestPath, MAX_APP_MANIFEST_BYTES);
    if (!document) continue;
    const parsed = AppManifestSchema.safeParse(document.value);
    if (!parsed.success || (candidate.relativePath !== app && parsed.data.slug !== app)) continue;
    matches.push({
      manifest: parsed.data,
      relativePath: candidate.relativePath,
      imported: hasImportedProvenance(document.value),
    });
  }
  if (matches.length !== 1) {
    const exactGrant = policy?.apps[app];
    return exactGrant ? { kind: "policy", grant: exactGrant } : null;
  }
  const { manifest, relativePath, imported } = matches[0]!;
  const aliases = [...new Set([relativePath, manifest.slug])];
  const grants = aliases.flatMap(alias => policy?.apps[alias] ? [policy.apps[alias]] : []);
  if (grants.length > 0) return { kind: "policy", grant: intersectGrants(grants) };
  if (imported) return null;
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
