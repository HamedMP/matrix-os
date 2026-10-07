import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeFile, mkdir, open, link, lstat, unlink, opendir } from "node:fs/promises";
import type { Dir } from "node:fs";
import { randomUUID } from "node:crypto";
import { ImageGenerationRequestSchema, IMAGE_MODEL } from "@matrix-os/contracts";
import { generateInteractionImage, validateImagePng, safeImageErrorDetails } from "@matrix-os/contracts/image-generation/server";
import { join, resolve } from "node:path";

export const DEFAULT_ICON_STYLE = "Create one individual app icon as a refined tactile 3D product illustration. Use one large rounded sculptural object with a distinct silhouette that clearly represents the app, rendered in matte or satin ceramic and clay with subtle tactile grain and gently rounded edges. Choose a restrained palette of mist blue, blush, indigo, mint and cream, varying the subject color across the family. Fill the complete 1:1 square canvas edge to edge with a pale near-white lavender opaque background. Center the prominent subject with comfortable breathing room, soft upper-left studio lighting, ambient occlusion and grounded contact shadows. Keep perspective, scale, materials and lighting consistent across the family. Include no text, letters, numbers, logos or watermarks; no transparent background, black/dark dock backdrop, baked-in rounded tile, border or visible frame; no sprite sheet or grid. The Matrix shell owns the final corner radius.";

export function loadIconStyle(homePath: string): string {
  try {
    const desktop = JSON.parse(readFileSync(join(homePath, "system/desktop.json"), "utf-8"));
    if (desktop.iconStyle) return desktop.iconStyle;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[image-gen] Failed to read desktop.json icon style:", err instanceof Error ? err.message : String(err));
    }
  }
  return DEFAULT_ICON_STYLE;
}

export function buildIconPrompt(slug: string, style: string): string {
  const name = slug.replace(/-/g, " ").replace(/_/g, " ");
  return `App icon for '${name}': ${style}, no text, 1:1 square`;
}

export interface IconBatchResult {
  generated: number;
  failed: string[];
}

export interface IconGenerationTarget {
  slug: string;
  icon?: string;
  name?: string;
}

export async function generateIconBatch(
  apiKey: string,
  targets: Array<string | IconGenerationTarget>,
  iconStyle: string,
  iconsDir: string,
  opts?: { skipExisting?: boolean },
): Promise<IconBatchResult> {
  const client = createImageClient(apiKey);
  let generated = 0;
  const failed: string[] = [];
  for (const target of targets) {
    const normalized = normalizeIconTarget(target);
    if (!normalized) {
      failed.push(describeIconTarget(target));
      continue;
    }
    if (opts?.skipExisting && existsSync(join(iconsDir, `${normalized.fileStem}.png`))) continue;
    try {
      await client.generateImage(buildIconPrompt(normalized.promptName, iconStyle), {
        aspectRatio: "1:1",
        imageDir: iconsDir,
        saveAs: `${normalized.fileStem}.png`,
      });
      generated++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[icons] Generation failed for "${normalized.slug}": ${msg}`);
      failed.push(normalized.slug);
    }
  }
  return { generated, failed };
}

function normalizeIconTarget(target: string | IconGenerationTarget): { slug: string; fileStem: string; promptName: string } | null {
  if (typeof target === "string") {
    return isSafeIconStem(target)
      ? { slug: target, fileStem: target, promptName: target }
      : null;
  }
  const slug = target.slug;
  const fileStem = isSafeIconStem(target.icon) ? target.icon : safeStemFromSlug(slug);
  if (!fileStem) return null;
  const promptName = typeof target.name === "string" && target.name.trim().length > 0
    ? target.name.trim()
    : slug;
  return { slug, fileStem, promptName };
}

function safeStemFromSlug(slug: string): string | null {
  const leaf = slug.split("/").filter(Boolean).at(-1);
  return isSafeIconStem(leaf) ? leaf : null;
}

function isSafeIconStem(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]+$/.test(value);
}

function describeIconTarget(target: string | IconGenerationTarget): string {
  return typeof target === "string" ? target : target.slug;
}

export function isSafeImageFileName(value: string): boolean {
  return value.length <= 200 && /^[a-zA-Z0-9_.-]+$/.test(value) && !value.includes("..") && value.endsWith(".png");
}

export interface ImageResult {
  localPath: string;
  model: string;
  cost: number;
}

export interface GenerateOptions {
  model?: string;
  aspectRatio?: string;
  imageSize?: string;
  imageDir: string;
  saveAs?: string;
  fetchFn?: typeof fetch;
  requestId?: string;
}

export interface ImageClient {
  generateImage(prompt: string, opts: GenerateOptions): Promise<ImageResult>;
  isConfigured(): boolean;
}

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const MODEL_COSTS: Record<string, number> = {
  "gemini-2.5-flash-image": 0.0002,
  "gemini-3.1-flash-image-preview": 0.0005,
  "gemini-3-pro-image-preview": 0.002,
};

const DEFAULT_MODEL = "gemini-2.5-flash-image";

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
  }>;
  error?: { message: string };
}

export function createImageClient(apiKey: string): ImageClient {
  return {
    isConfigured(): boolean {
      return Boolean(apiKey);
    },

    async generateImage(prompt: string, opts: GenerateOptions): Promise<ImageResult> {
      if (!apiKey) {
        throw new Error("Image generation not configured. Set GEMINI_API_KEY.");
      }

      const model = opts.model ?? DEFAULT_MODEL;
      const fetchFn = opts.fetchFn ?? globalThis.fetch;
      if (opts.saveAs && !isSafeImageFileName(opts.saveAs)) {
        throw new Error("Invalid image filename.");
      }

      if (model === IMAGE_MODEL) {
        await assertImageDestinationAvailable(opts);
        const input = ImageGenerationRequestSchema.parse({ requestId: opts.requestId ?? `byok_${randomUUID().replaceAll("-", "")}`, prompt, model, aspectRatio: opts.aspectRatio, imageSize: opts.imageSize });
        const result = await generateInteractionImage(apiKey, input, fetchFn);
        return { localPath: await saveGeneratedImage(validateImagePng(result.imageBase64), prompt, opts), model, cost: result.costMicrousd / 1_000_000 };
      }
      const url = `${API_BASE}/${model}:generateContent`;

      const imageConfig: Record<string, string> = {};
      if (opts.aspectRatio) imageConfig.aspectRatio = opts.aspectRatio;
      if (opts.imageSize) imageConfig.imageSize = opts.imageSize;

      const body = JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseModalities: ["IMAGE"],
          ...(Object.keys(imageConfig).length > 0 && { imageConfig }),
        },
      });

      const response = await fetchFn(url, {
        method: "POST",
        headers: {
          "x-goog-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body,
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new Error("Invalid API key. Check your GEMINI_API_KEY.");
        }
        if (response.status === 429) {
          throw new Error("Rate limit exceeded. Try again later.");
        }
        const errorData = await response.json().catch((err: unknown) => {
          console.warn("[image-gen] Could not parse error response:", err instanceof Error ? err.message : String(err));
          return {};
        }) as GeminiResponse;
        throw new Error(`Image generation failed: ${response.status} ${errorData?.error?.message ?? response.statusText}`);
      }

      const data = await response.json() as GeminiResponse;

      const imagePart = data.candidates?.[0]?.content?.parts?.find(
        (p) => p.inlineData?.mimeType?.startsWith("image/"),
      );

      if (!imagePart?.inlineData) {
        throw new Error("No image returned. The prompt may have been filtered by safety settings.");
      }

      const imageBuffer = Buffer.from(imagePart.inlineData.data, "base64");

      mkdirSync(opts.imageDir, { recursive: true });

      const slug = prompt
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, 40);
      const timestamp = Date.now();
      const fileName = opts.saveAs ?? `${timestamp}-${slug}.png`;
      if (!isSafeImageFileName(fileName)) {
        throw new Error("Invalid image filename.");
      }
      const localPath = join(opts.imageDir, fileName);

      await writeFile(localPath, imageBuffer);

      const cost = MODEL_COSTS[model] ?? 0.0005;

      return { localPath, model, cost };
    },
  };
}

/** Save the exact validated PNG bytes exclusively within the caller's fixed image directory. */

export async function assertImageDestinationAvailable(opts: Pick<GenerateOptions, "imageDir" | "saveAs">): Promise<void> {
  if (opts.saveAs && !isSafeImageFileName(opts.saveAs)) throw new Error("Invalid image filename.");
  await mkdir(opts.imageDir, { recursive: true });
  if (opts.saveAs) {
    try { await lstat(join(opts.imageDir, opts.saveAs)); }
    catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    throw new Error("Image filename is already in use.");
  }
}

export async function saveGeneratedImage(bytes: Uint8Array, prompt: string, opts: Pick<GenerateOptions, "imageDir" | "saveAs">): Promise<string> {
  if (activeImageStaging.size >= 32) throw new Error("Image generation is unavailable");
  const slug = prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
  const name = opts.saveAs ?? `${Date.now()}-${slug}-${randomUUID().slice(0, 8)}.png`;
  const path = join(opts.imageDir, name);
  const temporary = join(opts.imageDir, `.matrix-image-${randomUUID()}.tmp`);
  activeImageStaging.add(resolve(temporary));
  // A hard link publishes complete bytes atomically and refuses existing targets.
  // The private staging file is deleted on success and every handled failure.
  let ownsTemporary = false;
  try {
    await assertImageDestinationAvailable(opts);
    const file = await open(temporary, "wx", 0o600);
    ownsTemporary = true;
    try { await file.writeFile(bytes); } finally { await file.close(); }
    await link(temporary, path);
  } finally {
    try { if (ownsTemporary) await unlink(temporary); }
    catch (error: unknown) { if (!isMissingImageFile(error)) console.warn("[images] staging cleanup failed", safeImageErrorDetails(error)); }
    finally { activeImageStaging.delete(resolve(temporary)); }
  }
  return path;
}

// At most 32 concurrent saves; entries are removed on every completion/failure.
const activeImageStaging = new Set<string>();
function isMissingImageFile(error: unknown): boolean { return error instanceof Error && "code" in error && error.code === "ENOENT"; }

/** Gateway-owned recurring cleanup also covers process-killed saves. One cursor,
 * <=256 inspected entries and <=64 unlinks per run; never follow symlinks. */
export function createImageStagingCleanup(imageDir: string) {
  const directory = resolve(imageDir);
  let cursor: Dir | undefined;
  let directoryIdentity: { dev: number; ino: number } | undefined;
  let running: Promise<void> | undefined;
  let closed = false;
  async function closeCursor() { const previous = cursor; cursor = undefined; directoryIdentity = undefined; if (previous) await previous.close(); }
  async function scan() {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) { await closeCursor(); return; }
    if (directoryIdentity && (directoryIdentity.dev !== info.dev || directoryIdentity.ino !== info.ino)) await closeCursor();
    if (!cursor) { cursor = await opendir(directory); directoryIdentity = { dev: info.dev, ino: info.ino }; }
    let removed = 0;
    for (let count = 0; count < 256 && removed < 64 && !closed; count++) {
      const entry = await cursor.read();
      if (!entry) { await closeCursor(); break; }
      if (!/^\.matrix-image-[a-f0-9-]{36}\.tmp$/.test(entry.name)) continue;
      const path = join(directory, entry.name);
      if (activeImageStaging.has(path)) continue;
      try {
        const file = await lstat(path);
        if (!file.isFile() || file.isSymbolicLink() || file.mtimeMs > Date.now() - 24 * 60 * 60_000) continue;
        const parent = await lstat(directory);
        if (!parent.isDirectory() || parent.isSymbolicLink() || parent.dev !== info.dev || parent.ino !== info.ino) { await closeCursor(); break; }
        if (activeImageStaging.has(path)) continue;
        await unlink(path); removed++;
      } catch (error: unknown) { if (!isMissingImageFile(error)) throw error; }
    }
  }
  function sweep(): Promise<void> {
    if (closed) return Promise.resolve();
    if (!running) running = scan().catch(async (error: unknown) => {
      await closeCursor();
      if (!isMissingImageFile(error)) console.warn("[images] stale staging sweep failed", safeImageErrorDetails(error));
    }).finally(() => { running = undefined; });
    return running;
  }
  const timer = setInterval(() => { void sweep(); }, 10 * 60_000);
  timer.unref();
  void sweep();
  return { sweep, async close() { closed = true; clearInterval(timer); await running; await closeCursor(); } };
}
