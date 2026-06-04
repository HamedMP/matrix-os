import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export const DEFAULT_ICON_STYLE = "Light premium iOS/macOS skeuomorphic app icon artwork with refined Apple-like product rendering. Fill the entire 1:1 square canvas edge to edge with a bright warm off-white or pale pastel background, subtle ceramic/glass depth, soft bevels, glossy highlights, realistic studio shadows, and a single large tactile 3D object or symbol that clearly represents the app. Use dimensional glass/plastic/ceramic materials, crisp high-detail edges, friendly premium colors, and consistent lighting across the icon family. Do not include text, logos, watermarks, transparent background, black/dark dock backgrounds, or empty padding. The Matrix shell owns the final corner radius, so do not bake a separate visible icon frame into the artwork.";

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

function isSafeImageFileName(value: string): boolean {
  return /^[a-zA-Z0-9_.-]+$/.test(value) && !value.includes("..") && value.endsWith(".png");
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
