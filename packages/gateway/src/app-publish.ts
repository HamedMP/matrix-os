import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { loadAppManifest, type AppManifest } from "./app-manifest.js";

export function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

interface ValidationResult {
  valid: boolean;
  error?: string;
  manifest?: AppManifest;
}

interface ValidationOptions {
  maxSizeBytes?: number;
}

const DEFAULT_MAX_SIZE = 50 * 1024 * 1024; // 50MB

export function validateForPublish(
  appDir: string,
  options: ValidationOptions = {},
): ValidationResult {
  const maxSize = options.maxSizeBytes ?? DEFAULT_MAX_SIZE;

  const manifest = loadAppManifest(appDir);
  if (!manifest) {
    return { valid: false, error: "No valid matrix.json manifest found" };
  }

  if (!manifest.name) {
    return { valid: false, error: "Manifest must include a name" };
  }

  if (!manifest.description) {
    return { valid: false, error: "Manifest must include a description for publishing" };
  }

  const totalSize = getDirSize(appDir);
  if (totalSize > maxSize) {
    return {
      valid: false,
      error: `App size (${totalSize} bytes) exceeds maximum allowed size (${maxSize} bytes)`,
    };
  }

  return { valid: true, manifest };
}

function getDirSize(dir: string): number {
  let total = 0;
  const entries = readdirSync(dir);
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      total += getDirSize(fullPath);
    } else {
      total += stat.size;
    }
  }
  return total;
}

interface PublishPayload {
  name: string;
  slug: string;
  authorId: string;
  description: string;
  category: string;
  tags?: string;
  version: string;
  manifest: string;
  isPublic: boolean;
}

export function preparePublishPayload(
  appDir: string,
  authorId: string,
): PublishPayload | null {
  const validation = validateForPublish(appDir);
  if (!validation.valid || !validation.manifest) {
    return null;
  }

  const manifest = validation.manifest;
  const dirName = basename(appDir);
  const slug = generateSlug(manifest.name) || dirName;

  return {
    name: manifest.name,
    slug,
    authorId,
    description: manifest.description ?? "",
    category: manifest.category ?? "utility",
    version: manifest.version ?? "1.0.0",
    manifest: JSON.stringify(manifest),
    isPublic: true,
  };
}
