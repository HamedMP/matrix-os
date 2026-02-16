import { z } from "zod/v4";
import type { PluginManifest } from "./types.js";

export const PluginManifestSchema = z.object({
  id: z.string().min(1, "Plugin id is required"),
  name: z.string().optional(),
  version: z.string().optional(),
  description: z.string().optional(),
  configSchema: z.record(z.string(), z.unknown()).default({}),
  channels: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
});

export function validateManifest(raw: unknown): PluginManifest {
  return PluginManifestSchema.parse(raw) as PluginManifest;
}

export function safeValidateManifest(raw: unknown): { success: true; data: PluginManifest } | { success: false; error: string } {
  const result = PluginManifestSchema.safeParse(raw);
  if (result.success) {
    return { success: true, data: result.data as PluginManifest };
  }
  return { success: false, error: result.error.message };
}
