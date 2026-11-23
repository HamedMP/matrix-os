import { safeDownloadFilename } from "@matrix-os/contracts";

const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 32 * 1024 * 1024;
const IMAGE_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  "image/png": ["png"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/gif": ["gif"],
  "image/webp": ["webp"],
  "image/avif": ["avif"],
  "image/bmp": ["bmp"],
  "image/tiff": ["tiff", "tif"],
  "image/x-icon": ["ico"],
};

export function chatImageDownloadFilename(name: string, blob: Blob): string | null {
  const mime = blob.type.toLowerCase().split(";")[0]?.trim() ?? "";
  const extensions = Object.hasOwn(IMAGE_EXTENSIONS, mime) ? IMAGE_EXTENSIONS[mime] : undefined;
  if (!extensions || blob.size === 0 || blob.size > MAX_IMAGE_BYTES) return null;
  const basename = name.split("/").pop()?.trim() || "image";
  const suffix = /\.([a-z0-9]{1,16})$/i.exec(basename);
  if (suffix && extensions.includes(suffix[1]!.toLowerCase())) return safeDownloadFilename(basename);
  const stem = suffix ? basename.slice(0, suffix.index).trim() : basename;
  return safeDownloadFilename(`${stem || "image"}.${extensions[0]}`);
}

/** Rasterize into the PNG format supported by the native/browser clipboard. */
export async function copyFileImage(blob: Blob, isCurrent: () => boolean = () => true): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined"
    || blob.size > MAX_IMAGE_BYTES) throw new Error("ImageCopyUnavailable");
  const image = await createImageBitmap(blob);
  try {
    if (!image.width || !image.height || image.width * image.height > MAX_IMAGE_PIXELS
      || !isCurrent()) throw new Error("ImageCopyUnavailable");
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("ImageCopyUnavailable");
    context.drawImage(image, 0, 0);
    const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob((result) => {
      if (result) resolve(result); else reject(new Error("ImageCopyUnavailable"));
    }, "image/png"));
    if (!isCurrent() || png.size > MAX_IMAGE_BYTES) throw new Error("ImageCopyUnavailable");
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
  } finally { image.close(); }
}

export function savePreviewBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename.replace(/[\\/\u0000-\u001f\u007f]/g, "_").slice(0, 280) || "download";
  anchor.click();
  // Downloads consume the object URL asynchronously after the click returns.
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
