// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendHermesAttachmentPaths,
  createLocalAttachmentController,
} from "../../desktop/src/renderer/src/features/chat/attachments/local-attachment-controller";

const MiB = 1024 * 1024;

function file(name: string, size: number, type = "application/octet-stream"): File {
  return new File([new Uint8Array(size)], name, { type });
}

describe("local Desktop attachment controller", () => {
  const createObjectURL = vi.fn((value: Blob) => `blob:preview/${value.size}`);
  const revokeObjectURL = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("accepts exactly 10 MiB, rejects one byte over, caps eight, and preserves order", () => {
    const controller = createLocalAttachmentController({ api: {} as never });
    controller.add([
      file("exact.bin", 10 * MiB),
      file("too-large.bin", 10 * MiB + 1),
      ...Array.from({ length: 8 }, (_, index) => file(`item-${index}.txt`, 1, "text/plain")),
    ]);

    const items = controller.getSnapshot();
    expect(items).toHaveLength(8);
    expect(items.map((item) => item.file.name)).toEqual([
      "exact.bin",
      "too-large.bin",
      "item-0.txt",
      "item-1.txt",
      "item-2.txt",
      "item-3.txt",
      "item-4.txt",
      "item-5.txt",
    ]);
    expect(items[0]?.status).toBe("ready");
    expect(items[1]).toMatchObject({ status: "failed", error: "Files are limited to 10 MB." });
  });

  it("creates previews only for safe raster images and revokes them on remove and dispose", () => {
    const controller = createLocalAttachmentController({ api: {} as never });
    controller.add([
      file("screen.png", 8, "image/png"),
      file("vector.svg", 8, "image/svg+xml"),
      file("notes.txt", 8, "text/plain"),
    ]);
    const [png, svg, notes] = controller.getSnapshot();

    expect(png?.previewUrl).toBe("blob:preview/8");
    expect(svg?.previewUrl).toBeUndefined();
    expect(notes?.previewUrl).toBeUndefined();
    controller.remove(png!.localId);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:preview/8");

    controller.add([file("second.webp", 4, "image/webp")]);
    controller.dispose();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:preview/4");
  });

  it("rejects folder entries and unsafe filenames", () => {
    const controller = createLocalAttachmentController({ api: {} as never });
    const folderFile = file("inside.txt", 1, "text/plain");
    Object.defineProperty(folderFile, "webkitRelativePath", { value: "folder/inside.txt" });

    controller.add([folderFile, file("../secret.txt", 1, "text/plain")]);

    expect(controller.getSnapshot()).toEqual([]);
  });

  it("uploads at most three files concurrently, preserves order, and returns structured refs", async () => {
    const resolvers = new Map<string, (value: unknown) => void>();
    const putBytes = vi.fn((_path: string, uploaded: File) => new Promise((resolve) => {
      resolvers.set(uploaded.name, resolve);
    }));
    const controller = createLocalAttachmentController({
      api: { putBytes } as never,
      createId: (() => {
        let next = 0;
        return () => `stable_${next++}`;
      })(),
    });
    controller.add([
      file("first.txt", 1, "text/plain"),
      file("second.txt", 1, "text/plain"),
      file("third.txt", 1, "text/plain"),
      file("fourth.txt", 1, "text/plain"),
    ]);

    const upload = controller.uploadAll();
    await vi.waitFor(() => expect(putBytes).toHaveBeenCalledTimes(3));
    resolvers.get("second.txt")?.({ ok: true, path: "uploads/desktop-chat/stable_1-second.txt", size: 1 });
    await vi.waitFor(() => expect(putBytes).toHaveBeenCalledTimes(4));
    resolvers.get("fourth.txt")?.({ ok: true, path: "uploads/desktop-chat/stable_3-fourth.txt", size: 1 });
    resolvers.get("third.txt")?.({ ok: true, path: "uploads/desktop-chat/stable_2-third.txt", size: 1 });
    resolvers.get("first.txt")?.({ ok: true, path: "uploads/desktop-chat/stable_0-first.txt", size: 1 });

    await expect(upload).resolves.toEqual({
      ok: true,
      paths: [
        "uploads/desktop-chat/stable_0-first.txt",
        "uploads/desktop-chat/stable_1-second.txt",
        "uploads/desktop-chat/stable_2-third.txt",
        "uploads/desktop-chat/stable_3-fourth.txt",
      ],
      attachments: [
        expect.objectContaining({ id: "desktop_upload_stable_0", kind: "structured_ref", label: "first.txt", path: "uploads/desktop-chat/stable_0-first.txt" }),
        expect.objectContaining({ id: "desktop_upload_stable_1", kind: "structured_ref", label: "second.txt", path: "uploads/desktop-chat/stable_1-second.txt" }),
        expect.objectContaining({ id: "desktop_upload_stable_2", kind: "structured_ref", label: "third.txt", path: "uploads/desktop-chat/stable_2-third.txt" }),
        expect.objectContaining({ id: "desktop_upload_stable_3", kind: "structured_ref", label: "fourth.txt", path: "uploads/desktop-chat/stable_3-fourth.txt" }),
      ],
    });
    expect(putBytes).toHaveBeenNthCalledWith(
      1,
      "/api/files/blob?path=uploads%2Fdesktop-chat%2Fstable_0-first.txt",
      expect.any(File),
      { "content-type": "text/plain" },
      { timeoutMs: 30_000 },
    );
  });

  it("freezes attachment mutations while the submitted batch is uploading", async () => {
    let resolveUpload!: (value: { ok: true; path: string; size: number }) => void;
    const putBytes = vi.fn(() => new Promise((resolve) => {
      resolveUpload = resolve;
    }));
    const controller = createLocalAttachmentController({
      api: { putBytes } as never,
      createId: (() => {
        let next = 0;
        return () => `locked_${next++}`;
      })(),
    });
    controller.add([file("submitted.txt", 1, "text/plain")]);
    const submittedId = controller.getSnapshot()[0]!.localId;

    const upload = controller.uploadAll();
    await vi.waitFor(() => expect(putBytes).toHaveBeenCalledTimes(1));
    controller.add([file("late.txt", 1, "text/plain")]);
    controller.remove(submittedId);

    expect(controller.getSnapshot().map((item) => item.file.name)).toEqual(["submitted.txt"]);
    resolveUpload({
      ok: true,
      path: "uploads/desktop-chat/locked_0-submitted.txt",
      size: 1,
    });
    await expect(upload).resolves.toMatchObject({
      ok: true,
      paths: ["uploads/desktop-chat/locked_0-submitted.txt"],
    });
  });

  it("retains failed previews for Retry and reuses the stable destination", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const putBytes = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ ok: true, path: "uploads/desktop-chat/stable_retry-retry.txt", size: 1 });
    const controller = createLocalAttachmentController({
      api: { putBytes } as never,
      createId: () => "stable_retry",
    });
    controller.add([file("retry.txt", 1, "text/plain")]);
    const id = controller.getSnapshot()[0]!.localId;

    await expect(controller.uploadAll()).resolves.toEqual({ ok: false });
    expect(controller.getSnapshot()[0]).toMatchObject({ status: "failed", error: "Upload failed. Try again." });
    await controller.retry(id);

    expect(putBytes).toHaveBeenCalledTimes(2);
    expect(putBytes.mock.calls[1]?.[0]).toBe(putBytes.mock.calls[0]?.[0]);
    expect(warn).toHaveBeenCalledWith("[desktop attachments] upload failed:", "offline");
    await expect(controller.uploadAll()).resolves.toMatchObject({ ok: true });
  });

  it("appends both owner-readable path forms to the Hermes prompt", () => {
    expect(appendHermesAttachmentPaths("Review these", ["uploads/desktop-chat/a.png", "uploads/desktop-chat/b.txt"])).toBe(
      "Review these\n\nAttached files (available on your Matrix computer):\n"
      + "- ~/uploads/desktop-chat/a.png (/home/matrix/home/uploads/desktop-chat/a.png)\n"
      + "- ~/uploads/desktop-chat/b.txt (/home/matrix/home/uploads/desktop-chat/b.txt)",
    );
    expect(appendHermesAttachmentPaths("", ["uploads/desktop-chat/a.png"])).toContain("Please inspect the attached files.");
  });
});
