import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
        const errorData = await response.json().catch(() => ({})) as GeminiResponse;
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

      writeFileSync(localPath, imageBuffer);

      const cost = MODEL_COSTS[model] ?? 0.0005;

      return { localPath, model, cost };
    },
  };
}
