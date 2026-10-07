const mockExpoFetch = jest.fn();
const mockDocumentPick = jest.fn();
const mockImagePick = jest.fn();
const mockDelete = jest.fn();
const mockRequestMediaPermission = jest.fn();
const mockRequestCameraPermission = jest.fn();
jest.mock("expo/fetch", () => ({ fetch: (...args: unknown[]) => mockExpoFetch(...args) }));
jest.mock("expo-document-picker", () => ({ getDocumentAsync: (...args: unknown[]) => mockDocumentPick(...args) }));
jest.mock("expo-image-picker", () => ({ launchImageLibraryAsync: (...args: unknown[]) => mockImagePick(...args), requestMediaLibraryPermissionsAsync: mockRequestMediaPermission, requestCameraPermissionsAsync: mockRequestCameraPermission }));
jest.mock("expo-file-system", () => ({
  Paths: { cache: { uri: "file:///cache/" } },
  File: class { size = 4; exists = true; uri: string; constructor(mockUri: string) { this.uri = mockUri; } delete() { mockDelete(this.uri); } },
}));
import { cleanupSelectedDeviceFile, pickSelectedDeviceFiles, uploadSelectedDeviceFile } from "@/lib/selected-device-files";

describe("selected device data", () => {
  beforeEach(() => jest.clearAllMocks());
  it("only opens the system picker on request and preserves selected bytes without requesting library permission", async () => {
    mockDocumentPick.mockResolvedValue({ canceled: false, assets: [{ uri: "file:///cache/bank.csv", name: "bank.csv", size: 4, mimeType: "text/csv" }] });
    const assets = await pickSelectedDeviceFiles("files");
    expect(mockDocumentPick).toHaveBeenCalledWith(expect.objectContaining({ copyToCacheDirectory: true, base64: false }));
    expect(assets).toEqual([expect.objectContaining({ name: "bank.csv", size: 4, uri: "file:///cache/bank.csv" })]);
    expect(mockImagePick).not.toHaveBeenCalled();
  });
  it("photo selection uses images only and cancelled selection does not upload", async () => {
    mockImagePick.mockResolvedValue({ canceled: true, assets: null });
    expect(await pickSelectedDeviceFiles("photos")).toEqual([]);
    expect(mockImagePick).toHaveBeenCalledWith(expect.objectContaining({ mediaTypes: ["images"], allowsEditing: false, selectionLimit: 32, legacy: false }));
    expect(mockRequestMediaPermission).not.toHaveBeenCalled();
    expect(mockRequestCameraPermission).not.toHaveBeenCalled();
    expect(mockExpoFetch).not.toHaveBeenCalled();
  });
  it("uploads the selected local file to the captured runtime with auth and an abort deadline", async () => {
    mockExpoFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, path: "imports/bank.csv", size: 4 }) });
    const asset = { uri: "file:///cache/bank.csv", name: "bank.csv", size: 4, type: "text/csv" };
    await uploadSelectedDeviceFile("owner-token", "https://app.matrix-os.com/vm/computer-a?runtime=preview-1", asset, "imports/bank.csv", new AbortController().signal);
    expect(mockExpoFetch).toHaveBeenCalledWith("https://app.matrix-os.com/vm/computer-a/api/files/blob?runtime=preview-1&path=imports%2Fbank.csv", expect.objectContaining({
      method: "PUT", headers: { Authorization: "Bearer owner-token", "Content-Type": "text/csv" }, signal: expect.any(AbortSignal), body: expect.objectContaining({ uri: asset.uri }),
    }));
  });
  it("keeps raw gateway errors private and rejects remote source URLs before transport", async () => {
    mockExpoFetch.mockRejectedValue(new Error("provider path secret"));
    await expect(uploadSelectedDeviceFile("token", "https://app.matrix-os.com/vm/a", { uri: "file:///cache/a.csv", name: "a.csv", size: 4 }, "a.csv", new AbortController().signal)).rejects.toThrow("Upload failed. Try again.");
    mockExpoFetch.mockClear();
    await expect(uploadSelectedDeviceFile("token", "https://app.matrix-os.com/vm/a", { uri: "https://untrusted.example/a.csv", name: "a.csv", size: 4 }, "a.csv", new AbortController().signal)).rejects.toThrow();
    expect(mockExpoFetch).not.toHaveBeenCalled();
  });
  it("only cleans picker copies inside the application cache", () => {
    cleanupSelectedDeviceFile({ uri: "file:///cache/a.csv", name: "a.csv", size: 4 });
    cleanupSelectedDeviceFile({ uri: "file:///documents/a.csv", name: "a.csv", size: 4 });
    expect(mockDelete).toHaveBeenCalledTimes(1);
  });
});
