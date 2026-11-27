// The install record is the source of truth for an installed Matrix app
// (spec 2711). It lives only on this device and never carries a credential.
import { AppIdentitySchema } from "@matrix-os/contracts";
import { z } from "zod/v4";

export const MAX_INSTALLED_APPS = 64;

/** Random UUID; never derived from the app's owner-controlled folder name. */
export const InstallIdSchema = z.uuid();

// Same spelling the catalog resolver accepts for an explicit `matrix-app:` identity.
const InstalledAppSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);
// A code-directory hash is 20 bytes (SHA-1 or truncated SHA-256); allow full SHA-256 too.
const CdHashSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

export const InstalledAppRecordSchema = z.strictObject({
  installId: InstallIdSchema,
  appIdentity: AppIdentitySchema,
  slug: InstalledAppSlugSchema,
  runtimeSlot: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(128),
  iconSha256: Sha256HexSchema,
  /** Absolute bundle or shortcut path, written by the platform installer (later layers). */
  bundlePath: z.string().min(1).max(4096).nullable(),
  cdHashes: z.array(CdHashSchema).max(8),
  createdAt: z.iso.datetime(),
});
export type InstalledAppRecord = z.infer<typeof InstalledAppRecordSchema>;

export const NewInstalledAppSchema = InstalledAppRecordSchema.omit({ installId: true, createdAt: true });
export type NewInstalledApp = z.infer<typeof NewInstalledAppSchema>;

export const InstalledAppsFileSchema = z.strictObject({
  version: z.literal(1),
  records: z.array(InstalledAppRecordSchema).max(MAX_INSTALLED_APPS),
}).refine(
  (file) => new Set(file.records.map((record) => record.installId)).size === file.records.length,
  { message: "duplicate install id" },
);
