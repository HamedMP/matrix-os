const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 32 * 1024 * 1024;

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
