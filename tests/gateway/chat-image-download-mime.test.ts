import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createFilePreviewRoutes } from "../../packages/gateway/src/file-preview-routes.js";
import { createFilePreviewService } from "../../packages/gateway/src/file-preview-service.js";
import { chatImageDownloadFilename } from "../../packages/ui/src/files/file-image-actions.js";

// Synthetic red images encoded once with FFmpeg; tests need no external codec.
const images = {
  png: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEElEQVR4nGP8wwACLGCSAQANBAECv1AVswAAAABJRU5ErkJggg==", "base64"),
  avif: Buffer.from("AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAAD5bWV0YQAAAAAAAAAvaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAFBpY3R1cmVIYW5kbGVyAAAAAA5waXRtAAAAAAABAAAAHmlsb2MAAAAARAAAAQABAAAAAQAAASEAAAAkAAAAKGlpbmYAAAAAAAEAAAAaaW5mZQIAAAAAAQAAYXYwMUNvbG9yAAAAAGppcHJwAAAAS2lwY28AAAAUaXNwZQAAAAAAAABAAAAAQAAAABBwaXhpAAAAAAMICAgAAAAMYXYxQ4EADAAAAAATY29scm5jbHgAAgACAAIAAAAAF2lwbWEAAAAAAAAAAQABBAECgwQAAAAsbWRhdAoKAAAAAq//jV8wCDIWEAC6AgggQQEAAAgAldHifqxPBK2kcA==", "base64"),
  bmp: Buffer.from("Qk1GAAAAAAAAADYAAAAoAAAAAgAAAAIAAAABABgAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAD8AAD8AAAAAPwAAPwAAA==", "base64"),
  tiff: Buffer.from("SUkqAGEAAAD9UQFa8AgACAAIAEgAAAABAAAASAAAAAEAAABMYXZjNjIuMTEuMTAwAA8AAAABAAAA6wAAAAEAAACAAAAAAQAAAPAAAAABAAAAgAAAAAEAAADwAAAAAQAAABAA/gAEAAEAAAAAAAAAAAEEAAEAAAACAAAAAQEEAAEAAAACAAAAAgEDAAMAAAANAAAAAwEDAAEAAAAFgAAABgEDAAEAAAAGAAAAEQEEAAEAAAAIAAAAFQEDAAEAAAADAAAAFgEEAAEAAAAACAAAFwEEAAEAAAAFAAAAGgEFAAEAAAATAAAAGwEFAAEAAAAbAAAAKAEDAAEAAAACAAAAMQECAA4AAAAjAAAAEgIDAAIAAAACAAIAFAIFAAYAAAAxAAAAAAAAAA==", "base64"),
  ico: Buffer.from("AAABAAEAAgIAAAEAGAA6AAAAFgAAACgAAAACAAAABAAAAAEAGAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAPwAAPwAAAAA/AAA/AAAAAA=", "base64"),
};
const formats = [
  ["avif", "image/avif", "avif", images.avif],
  ["bmp", "image/bmp", "bmp", images.bmp],
  ["ico", "image/x-icon", "ico", images.ico],
  ["tif", "image/tiff", "tif", images.tiff],
  ["tiff", "image/tiff", "tiff", images.tiff],
  ["apng", "image/png", "png", images.png],
] as const;

// Header-only fixtures exercise MIME admission, not full AV1 image decoding.
function extendedAvifHeader(major: string, compatible: string[] = [], declaredSize?: bigint): Buffer {
  const header = Buffer.alloc(24 + compatible.length * 4);
  header.writeUInt32BE(1, 0);
  header.write("ftyp", 4, "ascii");
  header.writeBigUInt64BE(declaredSize ?? BigInt(header.length), 8);
  header.write(major, 16, "ascii");
  compatible.forEach((brand, index) => header.write(brand, 24 + index * 4, "ascii"));
  return header;
}

describe("Gateway raster image download MIME boundary", () => {
  let homePath: string;
  let app: ReturnType<typeof createFilePreviewRoutes>;
  const headers = { Authorization: "Bearer owner" };
  beforeEach(async () => {
    homePath = resolve(await mkdtemp(join(tmpdir(), "matrix-image-download-mime-")));
    app = createFilePreviewRoutes({
      service: createFilePreviewService({
        homePath,
        canAccessHome: principal => principal.userId === "owner",
        resolveProjectRoot: async () => null,
      }),
      getPrincipal: c => ({ userId: c.req.header("authorization") === "Bearer owner" ? "owner" : "other", source: "jwt" }),
    });
  });
  afterEach(async () => { await rm(homePath, { recursive: true, force: true }); });

  it.each(formats)("makes a real %s response downloadable with its original bytes and a raster filename", async (ext, mime, downloadExt, bytes) => {
    const name = `generated.${ext}`;
    await writeFile(join(homePath, name), bytes, { flag: "wx" });
    const query = `kind=home&path=${name}`;
    const response = await app.request(`/content?${query}&download=true`, { headers });
    expect(response.status).toBe(200);
    const blob = await response.blob();
    expect(chatImageDownloadFilename(name, blob)).toBe(`generated.${downloadExt}`);
    expect(blob.type).toBe(mime);
    expect(Buffer.from(await blob.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get("content-disposition")).toContain(`attachment; filename="${name}"`);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const metadata = await app.request(`/metadata?${query}`, { headers });
    await expect(metadata.json()).resolves.toMatchObject({ name, kind: "image", mimeType: mime, sizeBytes: bytes.length, canDownload: true });
    expect((await app.request(`/content?${query}`, { headers: { Authorization: "Bearer other" } })).status).toBe(404);
  });

  it.each(formats)("does not admit active markup disguised as %s to the image renderer", async (ext) => {
    const name = `misleading.${ext}`;
    await writeFile(join(homePath, name), '<html><script>alert(1)</script></html>', { flag: "wx" });
    const response = await app.request(`/metadata?kind=home&path=${name}`, { headers });
    await expect(response.json()).resolves.toMatchObject({ kind: "unsupported", mimeType: "application/octet-stream" });
    const content = await app.request(`/content?kind=home&path=${name}&download=true`, { headers });
    expect(chatImageDownloadFilename(name, await content.blob())).toBeNull();
  });

  it("accepts an AVIF compatible brand without treating a non-AVIF ftyp as an image", async () => {
    const compatible = Buffer.from(images.avif);
    compatible.write("mif1", 8, "ascii");
    await writeFile(join(homePath, "compatible.avif"), compatible, { flag: "wx" });
    const response = await app.request("/content?kind=home&path=compatible.avif", { headers });
    const blob = await response.blob();
    expect(chatImageDownloadFilename("compatible.avif", blob)).toBe("compatible.avif");
    expect(Buffer.from(await blob.arrayBuffer())).toEqual(compatible);

    const misleading = Buffer.alloc(32);
    misleading.writeUInt32BE(20, 0);
    misleading.write("ftypmif1", 4, "ascii");
    misleading.write("mif1", 16, "ascii");
    misleading.write("avif", 24, "ascii"); // Outside the declared ftyp box.
    await writeFile(join(homePath, "wrong-brand.avif"), misleading, { flag: "wx" });
    const metadata = await app.request("/metadata?kind=home&path=wrong-brand.avif", { headers });
    await expect(metadata.json()).resolves.toMatchObject({ kind: "unsupported", mimeType: "application/octet-stream" });
  });

  it.each([
    ["major", extendedAvifHeader("avif")],
    ["compatible", extendedAvifHeader("mif1", ["avif"])],
  ] as const)("admits an extended AVIF %s brand header (header-only fixture)", async (_brand, bytes) => {
    await writeFile(join(homePath, "extended.avif"), bytes, { flag: "wx" });
    const response = await app.request("/content?kind=home&path=extended.avif&download=true", { headers });
    const blob = await response.blob();
    expect(blob.type).toBe("image/avif");
    expect(chatImageDownloadFilename("extended.avif", blob)).toBe("extended.avif");
    expect(Buffer.from(await blob.arrayBuffer())).toEqual(bytes);
  });

  it.each([
    ["short header", extendedAvifHeader("avif").subarray(0, 20)],
    ["too-small box", extendedAvifHeader("avif", [], 20n)],
    ["brand outside the declared box", extendedAvifHeader("mif1", ["avif"], 24n)],
    ["unsafe 64-bit length", extendedAvifHeader("avif", [], 9_007_199_254_740_992n)],
    ["unaligned box length", extendedAvifHeader("avif", [], 25n)],
    ["brand beyond the sniff limit", extendedAvifHeader("mif1", [...Array<string>(122).fill("mif1"), "avif"])],
  ] as const)("rejects an extended AVIF %s (header-only fixture)", async (_reason, bytes) => {
    await writeFile(join(homePath, "rejected.avif"), bytes, { flag: "wx" });
    const response = await app.request("/metadata?kind=home&path=rejected.avif", { headers });
    await expect(response.json()).resolves.toMatchObject({ kind: "unsupported", mimeType: "application/octet-stream" });
  });
});
