/** Media types the Worker accepts and serves. SVG/HTML and anything scriptable are never allowed. */
export const MEDIA_TYPES = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
} as const;

export type MediaType = keyof typeof MEDIA_TYPES;
export type MediaExtension = (typeof MEDIA_TYPES)[MediaType];

export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_FILES_PER_REQUEST = 10;

const EXTENSION_TO_TYPE = new Map<string, MediaType>(
  (Object.entries(MEDIA_TYPES) as Array<[MediaType, MediaExtension]>).map(([type, ext]) => [ext, type]),
);

export function isMediaType(value: string): value is MediaType {
  return Object.hasOwn(MEDIA_TYPES, value);
}

export function mediaTypeForExtension(ext: string): MediaType | null {
  return EXTENSION_TO_TYPE.get(ext) ?? null;
}
