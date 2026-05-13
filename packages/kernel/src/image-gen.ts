import { mkdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export const DEFAULT_ICON_STYLE = "Minimal app icon filling the entire square canvas edge to edge with zero margin or padding, solid muted sage-cream background color #D1D3BC (a warm gray-green) that is IDENTICAL across ALL icons for a cohesive unified look, a single centered symbolic glyph or pictogram that clearly represents what the app does — the symbol color should be chosen from the Matrix OS design palette: Forest #434E3F (default, earthy dark green), Ember #D06F25 (warm terracotta orange), Deep #32352E (rich charcoal), or Cream #E0E1CA (soft warm light) — pick whichever color best suits the app's personality while maintaining contrast against the sage background, the glyph should be clean and geometric with organic rounded edges, instantly recognizable and directly related to the app purpose, no text, no transparency, no rounded corners (the UI container handles rounding), no gradients on the background (flat solid sage-cream), the symbol can have subtle depth or dimension but the background must remain flat #D1D3BC, every icon must look like part of the same family";

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
      const localPath = join(opts.imageDir, fileName);

      await writeFile(localPath, imageBuffer);

      const cost = MODEL_COSTS[model] ?? 0.0005;

      return { localPath, model, cost };
    },
  };
}
