// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { copyFileImage } from "../../packages/ui/src/files/file-image-actions";

const close = vi.fn();
const write = vi.fn();
const bitmap = { width: 800, height: 400, close };
const png = new Blob(["encoded-png"], { type: "image/png" });
beforeEach(() => {
  vi.clearAllMocks();
  write.mockResolvedValue(undefined);
  vi.stubGlobal("createImageBitmap", vi.fn(async () => bitmap));
  vi.stubGlobal("ClipboardItem", class { constructor(public data: Record<string, Blob>) {} });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write } });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => callback(png));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("writes PNG pixels rather than copying a path and closes decoded images", async () => {
  await copyFileImage(new Blob(["webp"], { type: "image/webp" }));
  expect(write.mock.calls[0][0][0].data).toEqual({ "image/png": png });
  expect(close).toHaveBeenCalledOnce();
});

it("never writes to the clipboard after the preview becomes stale during conversion", async () => {
  let current = true;
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => { current = false; callback(png); });
  await expect(copyFileImage(new Blob(["image"]), () => current)).rejects.toThrow("ImageCopyUnavailable");
  expect(write).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});

it("rejects oversized dimensions before canvas allocation", async () => {
  vi.mocked(createImageBitmap).mockResolvedValue({ ...bitmap, width: 10_000, height: 10_000 } as ImageBitmap);
  await expect(copyFileImage(new Blob(["image"]))).rejects.toThrow("ImageCopyUnavailable");
  expect(HTMLCanvasElement.prototype.getContext).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});

it("releases the decoded bitmap when clipboard permission fails", async () => {
  write.mockRejectedValue(new Error("NotAllowedError"));
  await expect(copyFileImage(new Blob(["image"]))).rejects.toThrow("NotAllowedError");
  expect(close).toHaveBeenCalledOnce();
});
