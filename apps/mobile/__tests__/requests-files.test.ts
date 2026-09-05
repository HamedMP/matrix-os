import {
  createFile,
  createFolder,
  fetchFileList,
  fetchFilePreview,
} from "@/lib/requests/files";

describe("file requests", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it("lists a directory on the selected computer while preserving its runtime route", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        path: "projects",
        entries: [
          { name: "matrix-os", type: "directory", gitStatus: null, children: 12 },
          { name: "notes.md", type: "file", gitStatus: null, size: 20 },
        ],
      }),
    } as unknown as Response);

    await expect(fetchFileList(
      "clerk-token",
      "https://app.matrix-os.com/vm/solar-vale?runtime=preview-1",
      "projects",
    )).resolves.toMatchObject({
      path: "projects",
      entries: [
        { name: "matrix-os", type: "directory" },
        { name: "notes.md", type: "file" },
      ],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://app.matrix-os.com/vm/solar-vale/api/files/list?runtime=preview-1&path=projects",
      expect.objectContaining({
        headers: { Authorization: "Bearer clerk-token" },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("rejects paths that escape the computer home directory", async () => {
    const fetchMock = jest.spyOn(global, "fetch");

    await expect(fetchFileList(
      "clerk-token",
      "https://app.matrix-os.com/vm/solar-vale",
      "../system",
    )).rejects.toThrow("Files unavailable. Try again.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates a folder through the selected computer route", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ ok: true, path: "projects/New folder" }),
    } as unknown as Response);

    await expect(createFolder(
      "clerk-token",
      "https://app.matrix-os.com/vm/solar-vale?runtime=preview-1",
      "projects",
      "New folder",
    )).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://app.matrix-os.com/vm/solar-vale/api/files/mkdir?runtime=preview-1",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer clerk-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ path: "projects/New folder" }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("creates an empty file through the selected computer route", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ ok: true, path: "notes.md" }),
    } as unknown as Response);

    await expect(createFile(
      "clerk-token",
      "https://app.matrix-os.com/vm/solar-vale",
      "",
      "notes.md",
    )).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://app.matrix-os.com/vm/solar-vale/api/files/touch",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ path: "notes.md" }),
      }),
    );
  });

  it("rejects invalid entry names before calling the gateway", async () => {
    const fetchMock = jest.spyOn(global, "fetch");

    await expect(createFolder(
      "clerk-token",
      "https://app.matrix-os.com/vm/solar-vale",
      "",
      "../private",
    )).rejects.toThrow("Could not create folder. Try again.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("loads a bounded text preview", async () => {
    const fetchMock = jest.spyOn(global, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue({
          name: "readme.md",
          path: "projects/readme.md",
          type: "file",
          size: 14,
          modified: "2026-08-30T00:00:00.000Z",
          created: "2026-08-30T00:00:00.000Z",
          mime: "text/markdown",
        }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        text: jest.fn().mockResolvedValue("Hello, Matrix!"),
      } as unknown as Response);

    await expect(fetchFilePreview(
      "clerk-token",
      "https://app.matrix-os.com/vm/solar-vale?runtime=preview-1",
      "projects/readme.md",
    )).resolves.toEqual({ kind: "text", content: "Hello, Matrix!" });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://app.matrix-os.com/vm/solar-vale/api/files/stat?runtime=preview-1&path=projects%2Freadme.md",
      expect.objectContaining({ headers: { Authorization: "Bearer clerk-token" } }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://app.matrix-os.com/vm/solar-vale/api/files/blob?runtime=preview-1&path=projects%2Freadme.md",
      expect.objectContaining({ headers: { Authorization: "Bearer clerk-token" } }),
    );
  });

  it("returns an authenticated native image source without downloading it into JavaScript", async () => {
    const fetchMock = jest.spyOn(global, "fetch");

    await expect(fetchFilePreview(
      "clerk-token",
      "https://app.matrix-os.com/vm/solar-vale?runtime=preview-1",
      "images/my photo.png",
    )).resolves.toEqual({
      kind: "image",
      uri: "https://app.matrix-os.com/vm/solar-vale/files/images/my%20photo.png?runtime=preview-1",
      authorization: "Bearer clerk-token",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not buffer text files above the preview limit", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        name: "large.log",
        path: "large.log",
        type: "file",
        size: 600 * 1024,
        modified: "2026-08-30T00:00:00.000Z",
        created: "2026-08-30T00:00:00.000Z",
        mime: "text/plain",
      }),
    } as unknown as Response);

    await expect(fetchFilePreview(
      "clerk-token",
      "https://app.matrix-os.com/vm/solar-vale",
      "large.log",
    )).resolves.toEqual({ kind: "unpreviewable", reason: "too-large", size: 600 * 1024 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a stat response without a trustworthy file size", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        name: "unknown.txt",
        path: "unknown.txt",
        type: "file",
        modified: "2026-08-30T00:00:00.000Z",
        created: "2026-08-30T00:00:00.000Z",
        mime: "text/plain",
      }),
    } as unknown as Response);

    await expect(fetchFilePreview(
      "clerk-token",
      "https://app.matrix-os.com/vm/solar-vale",
      "unknown.txt",
    )).resolves.toEqual({ kind: "unpreviewable", reason: "unknown-size" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
