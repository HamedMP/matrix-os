let mockFiles: Record<string, string> = {};
const mockPickDirectory = jest.fn();
const mockPickedWrite = jest.fn();
const mockCreatePickedFile = jest.fn((_name: string, _mimeType: string | null) => ({ write: mockPickedWrite }));

jest.mock("expo-file-system", () => {
  class File {
    uri: string;
    constructor(directory: string, name: string) {
      this.uri = `${directory}/${name}`;
    }
    get exists() {
      return this.uri in mockFiles;
    }
    create() {
      mockFiles[this.uri] = "";
    }
    write(content: string) {
      mockFiles[this.uri] = content;
    }
    delete() {
      delete mockFiles[this.uri];
    }
  }
  return {
    File,
    Paths: { cache: "file:///cache" },
    Directory: { pickDirectoryAsync: () => mockPickDirectory() },
  };
});

import { Platform, Share } from "react-native";

import { saveAccountRecords } from "../lib/account-records-file";

const RECORDS = '{"version":1}';
const CACHE_FILE = "file:///cache/matrix-account.json";

describe("saving account records", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    mockFiles = {};
  });

  describe("on iOS", () => {
    beforeEach(() => {
      jest.replaceProperty(Platform, "OS", "ios");
    });

    it("shares the records as a file and removes it once the sheet closes", async () => {
      let sharedContent: string | undefined;
      const share = jest.spyOn(Share, "share").mockImplementation(async (content) => {
        sharedContent = mockFiles[(content as { url: string }).url];
        return { action: "sharedAction" };
      });

      await expect(saveAccountRecords(RECORDS)).resolves.toBe(true);

      expect(share).toHaveBeenCalledWith({ url: CACHE_FILE });
      expect(sharedContent).toBe(RECORDS);
      expect(CACHE_FILE in mockFiles).toBe(false);
    });

    it("replaces a file left behind by an interrupted export", async () => {
      mockFiles[CACHE_FILE] = "stale";
      let sharedContent: string | undefined;
      jest.spyOn(Share, "share").mockImplementation(async (content) => {
        sharedContent = mockFiles[(content as { url: string }).url];
        return { action: "sharedAction" };
      });

      await saveAccountRecords(RECORDS);

      expect(sharedContent).toBe(RECORDS);
    });

    it("removes the file even when sharing fails", async () => {
      jest.spyOn(Share, "share").mockRejectedValue(new Error("share failed"));

      await expect(saveAccountRecords(RECORDS)).rejects.toThrow("share failed");

      expect(CACHE_FILE in mockFiles).toBe(false);
    });
  });

  describe("on Android", () => {
    beforeEach(() => {
      jest.replaceProperty(Platform, "OS", "android");
    });

    it("writes the records into the folder the user picks", async () => {
      const share = jest.spyOn(Share, "share");
      mockPickDirectory.mockResolvedValue({ createFile: mockCreatePickedFile });

      await expect(saveAccountRecords(RECORDS)).resolves.toBe(true);

      expect(mockCreatePickedFile).toHaveBeenCalledWith("matrix-account.json", "application/json");
      expect(mockPickedWrite).toHaveBeenCalledWith(RECORDS);
      // The whole export never goes into a share intent as text.
      expect(share).not.toHaveBeenCalled();
      expect(mockFiles).toEqual({});
    });

    it("saves nothing when the folder picker is dismissed", async () => {
      mockPickDirectory.mockRejectedValue(
        Object.assign(new Error("The file picker was cancelled by the user"), { code: "ERR_PICKER_CANCELLED" }),
      );

      await expect(saveAccountRecords(RECORDS)).resolves.toBe(false);

      expect(mockPickedWrite).not.toHaveBeenCalled();
    });

    it("reports a picker that failed instead of treating it as a dismissal", async () => {
      mockPickDirectory.mockRejectedValue(new Error("The app context is missing."));

      await expect(saveAccountRecords(RECORDS)).rejects.toThrow("The app context is missing.");

      expect(mockPickedWrite).not.toHaveBeenCalled();
    });

    it("reports a file that cannot be written", async () => {
      mockPickedWrite.mockImplementationOnce(() => {
        throw new Error("read-only folder");
      });
      mockPickDirectory.mockResolvedValue({ createFile: mockCreatePickedFile });

      await expect(saveAccountRecords(RECORDS)).rejects.toThrow("read-only folder");
    });
  });
});
