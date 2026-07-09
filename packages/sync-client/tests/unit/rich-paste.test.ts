import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RICH_PASTE_MAX_IMAGE_BYTES,
  processRichPasteTransaction,
  type RichPasteUploadClient,
} from "../../src/cli/rich-paste.js";

const pngBytes = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d,
]);

describe("cli/rich-paste", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "matrix-rich-paste-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  function uploadClient(remotePaths: string[]): RichPasteUploadClient {
    return {
      uploadPasteAssets: vi.fn(async ({ assets }) => assets.map((asset, index) => ({
        assetId: `paste_${index}`,
        path: remotePaths[index] ?? `/home/matrix/home/projects/.matrix-terminal-pastes/main/2026-07-08/paste_${index}.png`,
        homeRelativePath: `projects/.matrix-terminal-pastes/main/2026-07-08/paste_${index}.png`,
        mimeType: asset.mimeType,
        size: asset.bytes.byteLength,
      }))),
    };
  }

  it("rewrites quoted image paths with spaces while preserving surrounding prompt text", async () => {
    const localPath = join(tempDir, "Screenshot 2026-07-08 at 10.31.00.png");
    await writeFile(localPath, pngBytes);
    const client = uploadClient(["/home/matrix/home/projects/.matrix-terminal-pastes/main/2026-07-08/paste_0.png"]);

    const result = await processRichPasteTransaction({
      sessionName: "main",
      text: `"${localPath}" what about this?`,
      observablePaste: true,
      uploadClient: client,
    });

    expect(result.status).toBe("rewritten");
    expect(result.outgoingText).toBe(
      '"/home/matrix/home/projects/.matrix-terminal-pastes/main/2026-07-08/paste_0.png" what about this?',
    );
    expect(result.outgoingText).not.toContain(localPath);
    expect(client.uploadPasteAssets).toHaveBeenCalledTimes(1);
  });

  it("rewrites unquoted image paths with trailing punctuation", async () => {
    const localPath = join(tempDir, "screen.png");
    await writeFile(localPath, pngBytes);
    const client = uploadClient(["/home/matrix/home/projects/.matrix-terminal-pastes/main/2026-07-08/paste_0.png"]);

    const result = await processRichPasteTransaction({
      sessionName: "main",
      text: `inspect ${localPath}.`,
      observablePaste: true,
      uploadClient: client,
    });

    expect(result.status).toBe("rewritten");
    expect(result.outgoingText).toBe(
      "inspect /home/matrix/home/projects/.matrix-terminal-pastes/main/2026-07-08/paste_0.png.",
    );
  });

  it("passes through non-image paths without uploading", async () => {
    const localPath = join(tempDir, "notes.txt");
    await writeFile(localPath, "not an image");
    const client = uploadClient([]);

    const result = await processRichPasteTransaction({
      sessionName: "main",
      text: `read ${localPath}`,
      observablePaste: true,
      uploadClient: client,
    });

    expect(result).toEqual({
      status: "passthrough",
      outgoingText: `read ${localPath}`,
      assets: [],
    });
    expect(client.uploadPasteAssets).not.toHaveBeenCalled();
  });

  it("uploads multiple image paths once and preserves text order", async () => {
    const first = join(tempDir, "first.png");
    const second = join(tempDir, "second.png");
    await writeFile(first, pngBytes);
    await writeFile(second, pngBytes);
    const client = uploadClient([
      "/home/matrix/home/projects/.matrix-terminal-pastes/main/2026-07-08/first.png",
      "/home/matrix/home/projects/.matrix-terminal-pastes/main/2026-07-08/second.png",
    ]);

    const result = await processRichPasteTransaction({
      sessionName: "main",
      text: `compare ${first}\nwith "${second}"`,
      observablePaste: true,
      uploadClient: client,
    });

    expect(result.status).toBe("rewritten");
    expect(result.outgoingText).toBe(
      'compare /home/matrix/home/projects/.matrix-terminal-pastes/main/2026-07-08/first.png\nwith "/home/matrix/home/projects/.matrix-terminal-pastes/main/2026-07-08/second.png"',
    );
    expect(client.uploadPasteAssets).toHaveBeenCalledTimes(1);
    expect(vi.mocked(client.uploadPasteAssets).mock.calls[0]?.[0].assets).toHaveLength(2);
  });

  it("dedupes repeated image paths in one paste transaction", async () => {
    const localPath = join(tempDir, "same.png");
    await writeFile(localPath, pngBytes);
    const client = uploadClient(["/home/matrix/home/projects/.matrix-terminal-pastes/main/2026-07-08/same.png"]);

    const result = await processRichPasteTransaction({
      sessionName: "main",
      text: `${localPath} and again "${localPath}"`,
      observablePaste: true,
      uploadClient: client,
    });

    expect(result.status).toBe("rewritten");
    expect(result.outgoingText).toBe(
      '/home/matrix/home/projects/.matrix-terminal-pastes/main/2026-07-08/same.png and again "/home/matrix/home/projects/.matrix-terminal-pastes/main/2026-07-08/same.png"',
    );
    expect(vi.mocked(client.uploadPasteAssets).mock.calls[0]?.[0].assets).toHaveLength(1);
  });

  it("fails locally for missing image paths without uploading or forwarding local paths", async () => {
    const localPath = join(tempDir, "missing.png");
    const client = uploadClient([]);

    const result = await processRichPasteTransaction({
      sessionName: "main",
      text: `inspect ${localPath}`,
      observablePaste: true,
      uploadClient: client,
    });

    expect(result).toEqual({
      status: "failed",
      assets: [],
      failureCode: "local_read_failed",
      localMessage: "Image paste failed: local image could not be read.",
    });
    expect(client.uploadPasteAssets).not.toHaveBeenCalled();
  });

  it("falls back to the clipboard image for a single unreadable observable pasted image path", async () => {
    const localPath = join(tempDir, "missing.png");
    const client = uploadClient(["/home/matrix/home/projects/.matrix-terminal-pastes/main/2026-07-08/clipboard.png"]);
    const clipboardReader = {
      readImage: vi.fn(async () => ({
        status: "available" as const,
        candidate: {
          kind: "clipboard" as const,
          capturedAt: new Date("2026-07-08T10:31:00Z"),
          sizeBytes: pngBytes.byteLength,
          mimeType: "image/png" as const,
          bytes: new Uint8Array(pngBytes),
        },
      })),
    };

    const result = await processRichPasteTransaction({
      sessionName: "main",
      text: localPath,
      observablePaste: true,
      uploadClient: client,
      clipboardReader,
      localReadRetryDelaysMs: [],
    });

    expect(result.status).toBe("rewritten");
    expect(result.outgoingText).toBe("/home/matrix/home/projects/.matrix-terminal-pastes/main/2026-07-08/clipboard.png");
    expect(result.outgoingText).not.toContain(localPath);
    expect(clipboardReader.readImage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(client.uploadPasteAssets).mock.calls[0]?.[0].assets).toEqual([{
      name: "clipboard.png",
      mimeType: "image/png",
      bytes: new Uint8Array(pngBytes),
    }]);
  });

  it("falls back to the clipboard image for a single unreadable non-bracketed dropped image path", async () => {
    const localPath = join(tempDir, "missing.png");
    const client = uploadClient(["/home/matrix/home/projects/.matrix-terminal-pastes/main/2026-07-08/clipboard.png"]);
    const clipboardReader = {
      readImage: vi.fn(async () => ({
        status: "available" as const,
        candidate: {
          kind: "clipboard" as const,
          capturedAt: new Date("2026-07-08T10:31:00Z"),
          sizeBytes: pngBytes.byteLength,
          mimeType: "image/png" as const,
          bytes: new Uint8Array(pngBytes),
        },
      })),
    };

    const result = await processRichPasteTransaction({
      sessionName: "main",
      text: `"${localPath}" `,
      observablePaste: false,
      uploadClient: client,
      clipboardReader,
      localReadRetryDelaysMs: [],
    });

    expect(result.status).toBe("rewritten");
    expect(result.outgoingText).toBe('"/home/matrix/home/projects/.matrix-terminal-pastes/main/2026-07-08/clipboard.png" ');
    expect(clipboardReader.readImage).toHaveBeenCalledTimes(1);
  });

  it("decodes terminal-emitted unicode escapes in quoted dropped image paths", async () => {
    const actualPath = join(tempDir, "Screenshot 2026-07-09 at 5.13.48\u202fPM.png");
    await writeFile(actualPath, pngBytes);
    const client = uploadClient(["/home/matrix/home/projects/.matrix-terminal-pastes/main/2026-07-08/screenshot.png"]);
    const terminalPath = actualPath.replace("\u202f", "\\u202f");

    const result = await processRichPasteTransaction({
      sessionName: "main",
      text: `"${terminalPath}" `,
      observablePaste: false,
      uploadClient: client,
    });

    expect(result.status).toBe("rewritten");
    expect(result.outgoingText).toBe('"/home/matrix/home/projects/.matrix-terminal-pastes/main/2026-07-08/screenshot.png" ');
    expect(client.uploadPasteAssets).toHaveBeenCalledTimes(1);
  });

  it("rewrites single whole-input unquoted image paths with spaces", async () => {
    const localPath = join(tempDir, "Screenshot with spaces.png");
    await writeFile(localPath, pngBytes);
    const client = uploadClient(["/home/matrix/home/projects/.matrix-terminal-pastes/main/2026-07-08/spaces.png"]);

    const result = await processRichPasteTransaction({
      sessionName: "main",
      text: `${localPath} `,
      observablePaste: false,
      uploadClient: client,
    });

    expect(result.status).toBe("rewritten");
    expect(result.outgoingText).toBe("/home/matrix/home/projects/.matrix-terminal-pastes/main/2026-07-08/spaces.png ");
  });

  it("decodes backslash-escaped spaces in dropped image paths", async () => {
    const localPath = join(tempDir, "Screenshot escaped spaces.png");
    await writeFile(localPath, pngBytes);
    const client = uploadClient(["/home/matrix/home/projects/.matrix-terminal-pastes/main/2026-07-08/escaped.png"]);
    const escapedPath = localPath.replaceAll(" ", "\\ ");

    const result = await processRichPasteTransaction({
      sessionName: "main",
      text: escapedPath,
      observablePaste: false,
      uploadClient: client,
    });

    expect(result.status).toBe("rewritten");
    expect(result.outgoingText).toBe("/home/matrix/home/projects/.matrix-terminal-pastes/main/2026-07-08/escaped.png");
  });

  it("rewrites file url image paths with percent encoding", async () => {
    const localPath = join(tempDir, "Screenshot file url.png");
    await writeFile(localPath, pngBytes);
    const client = uploadClient(["/home/matrix/home/projects/.matrix-terminal-pastes/main/2026-07-08/file-url.png"]);

    const result = await processRichPasteTransaction({
      sessionName: "main",
      text: pathToFileURL(localPath).href,
      observablePaste: false,
      uploadClient: client,
    });

    expect(result.status).toBe("rewritten");
    expect(result.outgoingText).toBe("/home/matrix/home/projects/.matrix-terminal-pastes/main/2026-07-08/file-url.png");
  });

  it("retries transient single-path dropped images until the file becomes readable", async () => {
    const localPath = join(tempDir, "transient.png");
    const client = uploadClient(["/home/matrix/home/projects/.matrix-terminal-pastes/main/2026-07-08/transient.png"]);
    const writeLater = setTimeout(() => {
      void writeFile(localPath, pngBytes);
    }, 10);

    try {
      const result = await processRichPasteTransaction({
        sessionName: "main",
        text: localPath,
        observablePaste: false,
        uploadClient: client,
        localReadRetryDelaysMs: [25, 25],
      });

      expect(result.status).toBe("rewritten");
      expect(result.outgoingText).toBe("/home/matrix/home/projects/.matrix-terminal-pastes/main/2026-07-08/transient.png");
    } finally {
      clearTimeout(writeLater);
    }
  });

  it("does not use clipboard fallback for prose with an unreadable image path", async () => {
    const localPath = join(tempDir, "missing.png");
    const client = uploadClient([]);
    const clipboardReader = {
      readImage: vi.fn(async () => ({
        status: "available" as const,
        candidate: {
          kind: "clipboard" as const,
          capturedAt: new Date("2026-07-08T10:31:00Z"),
          sizeBytes: pngBytes.byteLength,
          mimeType: "image/png" as const,
          bytes: new Uint8Array(pngBytes),
        },
      })),
    };

    const result = await processRichPasteTransaction({
      sessionName: "main",
      text: `inspect ${localPath}`,
      observablePaste: true,
      uploadClient: client,
      clipboardReader,
    });

    expect(result.status).toBe("failed");
    expect(result.failureCode).toBe("local_read_failed");
    expect(clipboardReader.readImage).not.toHaveBeenCalled();
    expect(client.uploadPasteAssets).not.toHaveBeenCalled();
  });

  it("fails locally for unreadable non-file image paths", async () => {
    const localPath = join(tempDir, "directory.png");
    await mkdir(localPath);
    const client = uploadClient([]);

    const result = await processRichPasteTransaction({
      sessionName: "main",
      text: `inspect ${localPath}`,
      observablePaste: true,
      uploadClient: client,
    });

    expect(result.status).toBe("failed");
    expect(result.localMessage).toBe("Image paste failed: local image could not be read.");
    expect(client.uploadPasteAssets).not.toHaveBeenCalled();
  });

  it("fails locally for unsupported image content", async () => {
    const localPath = join(tempDir, "fake.png");
    await writeFile(localPath, "not a png");
    const client = uploadClient([]);

    const result = await processRichPasteTransaction({
      sessionName: "main",
      text: `inspect ${localPath}`,
      observablePaste: true,
      uploadClient: client,
    });

    expect(result.status).toBe("failed");
    expect(result.localMessage).toBe("Image paste failed: local image could not be read.");
    expect(client.uploadPasteAssets).not.toHaveBeenCalled();
  });

  it("fails locally for oversized images", async () => {
    const localPath = join(tempDir, "huge.png");
    await writeFile(localPath, Buffer.concat([
      pngBytes,
      Buffer.alloc(RICH_PASTE_MAX_IMAGE_BYTES + 1 - pngBytes.byteLength),
    ]));
    const client = uploadClient([]);

    const result = await processRichPasteTransaction({
      sessionName: "main",
      text: `inspect ${localPath}`,
      observablePaste: true,
      uploadClient: client,
    });

    expect(result.status).toBe("failed");
    expect(result.localMessage).toBe("Image paste failed: image is too large.");
    expect(client.uploadPasteAssets).not.toHaveBeenCalled();
  });

  it("rejects symlinked image paths without clipboard fallback", async () => {
    const target = join(tempDir, "target.png");
    const link = join(tempDir, "link.png");
    await writeFile(target, pngBytes);
    await symlink(target, link);
    const client = uploadClient([]);
    const clipboardReader = {
      readImage: vi.fn(async () => ({
        status: "available" as const,
        candidate: {
          kind: "clipboard" as const,
          capturedAt: new Date("2026-07-08T10:31:00Z"),
          sizeBytes: pngBytes.byteLength,
          mimeType: "image/png" as const,
          bytes: new Uint8Array(pngBytes),
        },
      })),
    };

    const result = await processRichPasteTransaction({
      sessionName: "main",
      text: link,
      observablePaste: true,
      uploadClient: client,
      clipboardReader,
    });

    expect(result.status).toBe("failed");
    expect(result.localMessage).toBe("Image paste failed: local image could not be read.");
    expect(clipboardReader.readImage).not.toHaveBeenCalled();
    expect(client.uploadPasteAssets).not.toHaveBeenCalled();
  });

  it("fails locally on upload failure without returning outgoing text", async () => {
    const localPath = join(tempDir, "screen.png");
    await writeFile(localPath, pngBytes);
    const client: RichPasteUploadClient = {
      uploadPasteAssets: vi.fn(async () => {
        throw new Error("/home/matrix/internal write failed");
      }),
    };

    const result = await processRichPasteTransaction({
      sessionName: "main",
      text: `inspect ${localPath}`,
      observablePaste: true,
      uploadClient: client,
    });

    expect(result).toEqual({
      status: "failed",
      assets: [],
      failureCode: "upload_failed",
      localMessage: "Image paste failed: upload did not complete.",
    });
    expect("outgoingText" in result).toBe(false);
  });
});
