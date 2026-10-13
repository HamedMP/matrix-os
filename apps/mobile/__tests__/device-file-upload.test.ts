import { putDeviceFile } from "../lib/device-file-upload";

const mockUpload = jest.fn();
const mockOpened: string[] = [];

jest.mock("expo-file-system", () => ({
  UploadType: { BINARY_CONTENT: 0, MULTIPART: 1 },
  File: class {
    constructor(uri: string) { mockOpened.push(uri); }
    upload(...args: unknown[]) { return mockUpload(...args); }
  },
}));

describe("sending a file from the phone", () => {
  afterEach(() => {
    mockOpened.length = 0;
    jest.clearAllMocks();
  });

  it("puts the file, whole and as it is, as the body of the request", async () => {
    mockUpload.mockResolvedValue({ status: 200, body: "{\"ok\":true}", headers: { "content-type": "application/json" } });
    const signal = new AbortController().signal;

    const result = await putDeviceFile({
      uri: "file:///cache/flowers.jpg",
      url: "https://app.matrix-os.com/vm/alice/api/files/blob?path=x",
      headers: { Authorization: "Bearer clerk-token", "Content-Type": "image/jpeg" },
      signal,
    });

    expect(mockOpened).toEqual(["file:///cache/flowers.jpg"]);
    expect(mockUpload).toHaveBeenCalledWith("https://app.matrix-os.com/vm/alice/api/files/blob?path=x", {
      httpMethod: "PUT",
      // Not a form: the route takes the file itself.
      uploadType: 0,
      sessionType: "foreground",
      headers: { Authorization: "Bearer clerk-token", "Content-Type": "image/jpeg" },
      signal,
    });
    // The response's own headers are not passed on.
    expect(result).toEqual({ status: 200, body: "{\"ok\":true}" });
  });

  it("answers with a refusal as it came, for the caller to judge", async () => {
    mockUpload.mockResolvedValue({ status: 413, body: "{\"error\":\"payload_too_large\"}", headers: {} });

    await expect(putDeviceFile({
      uri: "file:///cache/big.zip", url: "https://example.test/blob", headers: {}, signal: new AbortController().signal,
    })).resolves.toEqual({ status: 413, body: "{\"error\":\"payload_too_large\"}" });
  });

  it("fails when the file cannot be read or the upload is ended", async () => {
    mockUpload.mockRejectedValue(new Error("AbortError"));

    await expect(putDeviceFile({
      uri: "file:///cache/gone.jpg", url: "https://example.test/blob", headers: {}, signal: new AbortController().signal,
    })).rejects.toThrow("AbortError");
  });
});
