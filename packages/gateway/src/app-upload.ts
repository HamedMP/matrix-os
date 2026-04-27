import * as fs from "node:fs";
import { mkdirSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { AppManifestSchema } from "./app-manifest.js";

const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;
const writeFileNow = fs.writeFileSync as (
  path: fs.PathOrFileDescriptor,
  data: string,
  options?: fs.WriteFileOptions,
) => void;

export function validateUploadManifest(data: unknown): {
  valid: boolean;
  error?: string;
} {
  const result = AppManifestSchema.safeParse(data);
  if (!result.success) {
    return { valid: false, error: result.error.issues.map((i) => i.message).join(", ") };
  }
  return { valid: true };
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function handleAppUpload(
  homePath: string,
  slug: string | undefined,
  files: Record<string, string>,
): {
  success: boolean;
  slug?: string;
  appUrl?: string;
  error?: string;
} {
  const fileKeys = Object.keys(files);
  if (fileKeys.length === 0) {
    return { success: false, error: "No files provided" };
  }

  let manifestData: Record<string, unknown> | null = null;
  if (files["matrix.json"]) {
    try {
      manifestData = JSON.parse(files["matrix.json"]);
    } catch (err: unknown) {
      console.warn("[app-upload] Invalid manifest JSON:", err instanceof Error ? err.message : String(err));
      return { success: false, error: "Invalid manifest: matrix.json is not valid JSON" };
    }
    const validation = validateUploadManifest(manifestData);
    if (!validation.valid) {
      return { success: false, error: `Invalid manifest: ${validation.error}` };
    }
  }

  if (!slug && manifestData?.name) {
    slug = slugify(manifestData.name as string);
  }
  if (!slug) {
    slug = `app-${Date.now()}`;
  }

  if (!SLUG_RE.test(slug)) {
    return { success: false, error: `Invalid slug: '${slug}' must match ${SLUG_RE}` };
  }

  const appsDir = join(homePath, "apps");
  const appDir = join(appsDir, slug);

  if (existsSync(appDir)) {
    rmSync(appDir, { recursive: true, force: true });
  }
  mkdirSync(appDir, { recursive: true });

  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(appDir, path);
    const dir = dirname(fullPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileNow(fullPath, content, "utf-8");
  }

  if (!files["matrix.json"]) {
    const autoManifest = {
      name: slug,
      runtime: "static",
      category: "utility",
      version: "1.0.0",
    };
    writeFileNow(
      join(appDir, "matrix.json"),
      JSON.stringify(autoManifest, null, 2),
      "utf-8",
    );
  }

  return {
    success: true,
    slug,
    appUrl: `/files/apps/${slug}/index.html`,
  };
}
