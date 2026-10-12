import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import { AppIdentitySchema } from "@matrix-os/contracts";
import { readBoundedJsonFileWithIdentity } from "../bounded-json-file.js";

const Name = z.string().min(1).max(128).regex(/^[a-z][a-z0-9_-]*$/);
export const AppCapabilityPolicySchema = z.strictObject({
  apps: z.record(AppIdentitySchema, z.strictObject({
    services: z.record(Name, z.array(Name).min(1).max(128)).refine(value => Object.keys(value).length <= 100),
  })).refine(value => Object.keys(value).length <= 100),
});
export type AppCapabilityGrant = z.infer<typeof AppCapabilityPolicySchema>["apps"][string];

/** App-authored manifests cannot grant integration access. Read owner policy each request. */
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
