export const CANVAS_ASSET_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"] as const;

export type CanvasAssetMimeType = typeof CANVAS_ASSET_MIME_TYPES[number];

const CANVAS_ASSET_EXTENSION_BY_MIME: Record<CanvasAssetMimeType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

const CANVAS_ASSET_MIME_TYPE_SET = new Set<string>(CANVAS_ASSET_MIME_TYPES);
const CANVAS_ASSET_PATH = /^system\/canvas-assets\/cnv_[A-Za-z0-9_-]+\/asset_[A-Za-z0-9_-]+\.(?:png|jpg|webp|gif|avif)$/;

export function isCanvasAssetMimeType(value: string): value is CanvasAssetMimeType {
  return CANVAS_ASSET_MIME_TYPE_SET.has(value);
}

export function canvasAssetExtensionForMimeType(value: string): string | undefined {
  if (!isCanvasAssetMimeType(value)) return undefined;
  return CANVAS_ASSET_EXTENSION_BY_MIME[value];
}

export function isCanvasAssetPath(value: string): boolean {
  return CANVAS_ASSET_PATH.test(value);
}
