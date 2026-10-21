import { MAX_PHOTO_EDGE, pickFiles, pickPhotos } from "../lib/chat-attachment-picker";
import { chatAttachmentUploadPath } from "../lib/chat-attachments";

const mockLaunchImageLibrary = jest.fn();
const mockPickFile = jest.fn();
const mockManipulate = jest.fn();
// Sizes of files on the phone, by where they are.
let mockFileSizes: Record<string, number> = {};

jest.mock("expo-image-picker", () => ({
  launchImageLibraryAsync: (...args: unknown[]) => mockLaunchImageLibrary(...args),
}));

jest.mock("expo-image-manipulator", () => ({
  ImageManipulator: { manipulate: (...args: unknown[]) => mockManipulate(...args) },
  SaveFormat: { JPEG: "jpeg", PNG: "png", WEBP: "webp" },
}));

jest.mock("expo-file-system", () => ({
  File: class {
    uri: string;
    constructor(uri: string) { this.uri = uri; }
    get size() {
      const size = mockFileSizes[this.uri];
      if (size === undefined) throw new Error("no such file");
      return size;
    }
    static pickFileAsync(...args: unknown[]) { return mockPickFile(...args); }
  },
}));

const MB = 1024 * 1024;

function asset(overrides: Record<string, unknown> = {}) {
  return {
    uri: "file:///cache/picked.jpg",
    width: 1_200,
    height: 900,
    fileName: "IMG_0001.jpg",
    fileSize: 300_000,
    mimeType: "image/jpeg",
    ...overrides,
  };
}

function chose(...assets: unknown[]) {
  mockLaunchImageLibrary.mockResolvedValue({ canceled: false, assets });
}

/** A scaled copy saved at `uri`, `sizeBytes` large. */
function scalesTo(uri: string, sizeBytes: number) {
  mockFileSizes[uri] = sizeBytes;
  const image = { saveAsync: jest.fn(async () => ({ uri })), release: jest.fn() };
  const context = { resize: jest.fn(), renderAsync: jest.fn(async () => image), release: jest.fn() };
  context.resize.mockReturnValue(context);
  mockManipulate.mockReturnValue(context);
  return { context, image };
}

function file(name: string, type: string, size: number) {
  return { uri: `file:///tmp/${name}`, name, type, size };
}

describe("choosing attachments", () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    mockFileSizes = {};
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    jest.clearAllMocks();
  });

  describe("photos", () => {
    it("opens the library for photos only, up to as many as the message can still carry", async () => {
      chose(asset());

      await pickPhotos(3);

      expect(mockLaunchImageLibrary).toHaveBeenCalledWith(expect.objectContaining({
        mediaTypes: ["images"],
        allowsMultipleSelection: true,
        selectionLimit: 3,
      }));
    });

    it("is nothing when the person backs out", async () => {
      mockLaunchImageLibrary.mockResolvedValue({ canceled: true, assets: null });

      await expect(pickPhotos(8)).resolves.toBeNull();
    });

    it("attaches a photo that already fits as it is", async () => {
      chose(asset());

      const picked = await pickPhotos(8);

      expect(picked?.rejections).toEqual([]);
      expect(picked?.attachments).toEqual([{
        id: expect.stringMatching(/^att_[a-f0-9]{32}$/),
        uri: "file:///cache/picked.jpg",
        name: "IMG_0001.jpg",
        mimeType: "image/jpeg",
        kind: "image",
        sizeBytes: 300_000,
      }]);
      expect(mockManipulate).not.toHaveBeenCalled();
    });

    it("scales a photo with a longer side than is sent down to it, as a JPEG", async () => {
      chose(asset({ width: 5_712, height: 4_284, fileSize: 4 * MB }));
      const { context, image } = scalesTo("file:///cache/scaled.jpg", 600_000);

      const picked = await pickPhotos(8);

      expect(context.resize).toHaveBeenCalledWith({ width: MAX_PHOTO_EDGE });
      expect(image.saveAsync).toHaveBeenCalledWith({ format: "jpeg", compress: 0.8 });
      expect(picked?.attachments).toMatchObject([{
        uri: "file:///cache/scaled.jpg", name: "IMG_0001.jpg", mimeType: "image/jpeg", sizeBytes: 600_000,
      }]);
      // What the scaling held is let go of.
      expect(image.release).toHaveBeenCalled();
      expect(context.release).toHaveBeenCalled();
    });

    it("scales a tall photo by its height", async () => {
      chose(asset({ width: 1_206, height: 2_622, fileName: "Screenshot.png", mimeType: "image/png" }));
      const { context } = scalesTo("file:///cache/scaled.jpg", 250_000);

      const picked = await pickPhotos(8);

      expect(context.resize).toHaveBeenCalledWith({ height: MAX_PHOTO_EDGE });
      expect(picked?.attachments).toMatchObject([{ name: "Screenshot.jpg", mimeType: "image/jpeg" }]);
    });

    it("converts a type models do not read, such as HEIC, without changing its size", async () => {
      chose(asset({ fileName: "IMG_0002.HEIC", mimeType: "image/heic" }));
      const { context } = scalesTo("file:///cache/converted.jpg", 280_000);

      const picked = await pickPhotos(8);

      expect(context.resize).not.toHaveBeenCalled();
      expect(picked?.attachments).toMatchObject([{ name: "IMG_0002.jpg", mimeType: "image/jpeg", sizeBytes: 280_000 }]);
    });

    it("re-encodes a photo that fits by its sides but not by its size", async () => {
      chose(asset({ fileSize: 6 * MB }));
      scalesTo("file:///cache/smaller.jpg", 900_000);

      expect((await pickPhotos(8))?.attachments).toMatchObject([{ sizeBytes: 900_000 }]);
    });

    it("leaves out a photo that is still too large after scaling", async () => {
      chose(asset({ width: 9_000, height: 9_000, fileSize: 40 * MB }));
      scalesTo("file:///cache/scaled.jpg", 7 * MB);

      await expect(pickPhotos(8)).resolves.toEqual({ attachments: [], rejections: ["too_large"] });
    });

    it("leaves out an animation that is too large instead of sending a still of it", async () => {
      chose(asset({ fileName: "loop.gif", mimeType: "image/gif", fileSize: 9 * MB }));

      await expect(pickPhotos(8)).resolves.toEqual({ attachments: [], rejections: ["too_large"] });
      expect(mockManipulate).not.toHaveBeenCalled();
    });

    it("reads the size from the file when the library does not give one, and names a nameless photo", async () => {
      mockFileSizes["file:///cache/picked.jpg"] = 123_456;
      chose(asset({ fileSize: undefined, fileName: null }));

      expect((await pickPhotos(8))?.attachments).toMatchObject([{ name: "photo-1.jpg", sizeBytes: 123_456 }]);
    });

    it("ends a photo's name like its type when the library names it without an ending", async () => {
      chose(
        asset({ fileName: "1000012345", mimeType: "image/png" }),
        asset({ fileName: "IMG_0004", mimeType: "image/jpeg" }),
      );

      const picked = await pickPhotos(8);

      expect(picked?.attachments.map((item) => item.name)).toEqual(["1000012345.png", "IMG_0004.jpg"]);
      // So the place it is uploaded to says it is a picture, with the phone's copy gone too.
      expect(picked?.attachments.map((item) => chatAttachmentUploadPath(item))).toEqual([
        expect.stringMatching(/-1000012345\.png$/),
        expect.stringMatching(/-IMG_0004\.jpg$/),
      ]);
      expect(mockManipulate).not.toHaveBeenCalled();
    });

    it("leaves out a photo that cannot be read and keeps the others", async () => {
      chose(asset({ uri: "file:///cache/gone.jpg", fileSize: undefined }), asset({ fileName: "IMG_0003.jpg" }));

      const picked = await pickPhotos(8);

      expect(picked?.rejections).toEqual(["unreadable"]);
      expect(picked?.attachments.map((item) => item.name)).toEqual(["IMG_0003.jpg"]);
    });

    it("leaves out an empty photo", async () => {
      chose(asset({ fileSize: 0 }));

      await expect(pickPhotos(8)).resolves.toEqual({ attachments: [], rejections: ["unreadable"] });
    });

    it("gives each photo an id of its own", async () => {
      chose(asset({ fileName: "a.jpg" }), asset({ fileName: "b.jpg" }), asset({ fileName: "c.jpg" }));

      const ids = (await pickPhotos(8))!.attachments.map((item) => item.id);

      expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
    });

    it("keeps to the limit when the library returns more than was asked for", async () => {
      chose(asset({ fileName: "a.jpg" }), asset({ fileName: "b.jpg" }), asset({ fileName: "c.jpg" }));

      const picked = await pickPhotos(2);

      expect(picked?.attachments.map((item) => item.name)).toEqual(["a.jpg", "b.jpg"]);
      expect(picked?.rejections).toEqual(["over_limit"]);
    });

    it("does not open the library when the message can carry no more", async () => {
      await expect(pickPhotos(0)).resolves.toEqual({ attachments: [], rejections: ["over_limit"] });
      expect(mockLaunchImageLibrary).not.toHaveBeenCalled();
    });

    it("fails when the library cannot be opened", async () => {
      mockLaunchImageLibrary.mockRejectedValue(new Error("no library"));

      await expect(pickPhotos(8)).rejects.toThrow("no library");
    });
  });

  describe("files", () => {
    it("accepts an ordinary file at exactly 10 MiB and rejects one byte more", async () => {
      mockPickFile.mockResolvedValue({ canceled: false, result: [file("exact.bin", "application/octet-stream", 10 * MB), file("extra.bin", "application/octet-stream", 10 * MB + 1)] });
      const picked = await pickFiles(8, ["file"]);
      expect(picked?.attachments).toMatchObject([{ name: "exact.bin", sizeBytes: 10 * MB }]);
      expect(picked?.rejections).toEqual(["too_large"]);
    });
    it("attaches the files chosen in the system's browser", async () => {
      mockPickFile.mockResolvedValue({
        canceled: false,
        result: [file("notes.txt", "text/plain", 1_200), file("chart.png", "image/png", 90_000)],
      });

      const picked = await pickFiles(8, ["image", "file"]);

      expect(mockPickFile).toHaveBeenCalledWith({ multipleFiles: true });
      expect(picked?.rejections).toEqual([]);
      expect(picked?.attachments).toMatchObject([
        { uri: "file:///tmp/notes.txt", name: "notes.txt", mimeType: "text/plain", kind: "file", sizeBytes: 1_200 },
        { uri: "file:///tmp/chart.png", name: "chart.png", mimeType: "image/png", kind: "image", sizeBytes: 90_000 },
      ]);
    });

    it("ends a picture's name like its type when the file has no ending", async () => {
      mockPickFile.mockResolvedValue({
        canceled: false,
        result: [file("scan", "image/png", 90_000), file("notes", "text/plain", 1_200)],
      });

      const picked = await pickFiles(8, ["image", "file"]);

      expect(picked?.attachments).toMatchObject([
        { uri: "file:///tmp/scan", name: "scan.png", kind: "image" },
        { uri: "file:///tmp/notes", name: "notes", kind: "file" },
      ]);
    });

    it("is nothing when the person backs out", async () => {
      mockPickFile.mockResolvedValue({ canceled: true, result: null });

      await expect(pickFiles(8, ["file"])).resolves.toBeNull();
    });

    it("leaves out a kind the selected model does not read", async () => {
      mockPickFile.mockResolvedValue({
        canceled: false,
        result: [file("notes.txt", "text/plain", 1_200), file("chart.png", "image/png", 90_000)],
      });

      const picked = await pickFiles(8, ["file"]);

      expect(picked?.attachments.map((item) => item.name)).toEqual(["notes.txt"]);
      expect(picked?.rejections).toEqual(["unsupported"]);
    });

    it("leaves out files that are too large or empty, and those past the limit", async () => {
      mockPickFile.mockResolvedValue({
        canceled: false,
        result: [
          file("big.zip", "application/zip", 10 * MB + 1),
          file("empty.txt", "text/plain", 0),
          file("kept.pdf", "application/pdf", 40_000),
          file("extra.pdf", "application/pdf", 40_000),
        ],
      });

      const picked = await pickFiles(3, ["file"]);

      expect(picked?.attachments.map((item) => item.name)).toEqual(["kept.pdf"]);
      expect(picked?.rejections).toEqual(["too_large", "unreadable", "over_limit"]);
    });

    it("sends a file whose type the system does not know as plain bytes", async () => {
      mockPickFile.mockResolvedValue({ canceled: false, result: [file("data.bin", "", 500)] });

      expect((await pickFiles(8, ["file"]))?.attachments).toMatchObject([
        { mimeType: "application/octet-stream", kind: "file" },
      ]);
    });

    it("does not open the browser when the message can carry no more", async () => {
      await expect(pickFiles(0, ["file"])).resolves.toEqual({ attachments: [], rejections: ["over_limit"] });
      expect(mockPickFile).not.toHaveBeenCalled();
    });
  });
});
