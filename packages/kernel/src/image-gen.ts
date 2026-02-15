import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ImageResult {
  url: string;
  localPath: string;
  model: string;
  cost: number;
}

export interface GenerateOptions {
  model?: string;
  size?: string;
  imageDir: string;
  saveAs?: string;
  fetchFn?: typeof fetch;
  downloadFn?: (url: string) => Promise<Buffer>;
}

export interface ImageClient {
  generateImage(prompt: string, opts: GenerateOptions): Promise<ImageResult>;
  isConfigured(): boolean;
}

const MODEL_COSTS: Record<string, number> = {
  "fal-ai/flux/schnell": 0.003,
  "fal-ai/flux/dev": 0.025,
};

export function createImageClient(apiKey: string): ImageClient {
  return {
    isConfigured(): boolean {
      return Boolean(apiKey);
    },

    async generateImage(prompt: string, opts: GenerateOptions): Promise<ImageResult> {
      if (!apiKey) {
        throw new Error("Image generation not configured. Set FAL_API_KEY.");
      }

      const model = opts.model ?? "fal-ai/flux/schnell";
      const size = opts.size ?? "1024x1024";
      const fetchFn = opts.fetchFn ?? globalThis.fetch;

      const url = `https://fal.run/${model}`;
      const body = JSON.stringify({
        prompt,
        image_size: size,
        num_images: 1,
      });

      const response = await fetchFn(url, {
        method: "POST",
        headers: {
          Authorization: `Key ${apiKey}`,
          "Content-Type": "application/json",
        },
        body,
      });

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error("Invalid API key. Check your FAL_API_KEY.");
        }
        if (response.status === 429) {
          throw new Error("Rate limit exceeded. Try again later.");
        }
        const errorData = await response.json().catch(() => ({}));
        throw new Error(`Image generation failed: ${response.status} ${(errorData as any).detail ?? response.statusText}`);
      }

      const data = await response.json() as { images: Array<{ url: string }> };
      const imageUrl = data.images[0].url;

      mkdirSync(opts.imageDir, { recursive: true });

      const slug = prompt
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, 40);
      const timestamp = Date.now();
      const fileName = opts.saveAs ?? `${timestamp}-${slug}.png`;
      const localPath = join(opts.imageDir, fileName);

      const downloadFn = opts.downloadFn ?? defaultDownload;
      const imageBuffer = await downloadFn(imageUrl);
      writeFileSync(localPath, imageBuffer);

      const cost = MODEL_COSTS[model] ?? 0.003;

      return { url: imageUrl, localPath, model, cost };
    },
  };
}

async function defaultDownload(url: string): Promise<Buffer> {
  const response = await fetch(url);
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
