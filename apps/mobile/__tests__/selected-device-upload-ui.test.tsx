const mockPick = jest.fn();
const mockUpload = jest.fn();
const mockInvalidate = jest.fn();
const mockCleanup = jest.fn();
const mockGetToken = jest.fn();
jest.mock("@clerk/clerk-expo", () => ({ useAuth: () => ({ userId: "owner", getToken: mockGetToken }) }));
jest.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: mockInvalidate }) }));
jest.mock("@/lib/analytics", () => ({ AnalyticsMask: require("react-native").View }));
jest.mock("@/lib/selected-device-files", () => ({ pickSelectedDeviceFiles: (...args: unknown[]) => mockPick(...args), uploadSelectedDeviceFile: (...args: unknown[]) => mockUpload(...args), cleanupSelectedDeviceFile: (asset: unknown) => mockCleanup(asset) }));
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SelectedDeviceUploadPanel } from "@/components/files/SelectedDeviceUploadPanel";

const computer = { handle: "solar-vale", runtimeSlot: "preview-1", gatewayPath: "/vm/solar-vale?runtime=preview-1" };
const asset = { name: "bank.csv", uri: "file:///cache/bank.csv", size: 4 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

describe("Native Mobile selected upload", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const mock of [mockPick, mockUpload, mockGetToken, mockCleanup, mockInvalidate]) mock.mockReset();
    mockGetToken.mockResolvedValue("owner-token");
  });
  it("opens the selected picker, shows progress, keeps failures and retries the same computer", async () => {
    const asset = { name: "bank.csv", uri: "file:///cache/bank.csv", size: 4 };
    mockPick.mockResolvedValue([asset]);
    mockUpload.mockRejectedValueOnce(new Error("secret")).mockResolvedValue(undefined);
    render(<SelectedDeviceUploadPanel currentPath="imports" computer={{ handle: "solar-vale", runtimeSlot: "preview-1", gatewayPath: "/vm/solar-vale?runtime=preview-1" }} />);
    expect(screen.getByText("Upload to solar-vale")).toBeTruthy();
    fireEvent.press(screen.getByLabelText("Choose files"));
    await screen.findByText("Upload failed. Try again.");
    expect(mockPick).toHaveBeenCalledWith("files");
    expect(mockUpload).toHaveBeenCalledWith("owner-token", expect.stringContaining("/vm/solar-vale?runtime=preview-1"), asset, "imports/bank.csv", expect.any(AbortSignal));
    fireEvent.press(screen.getByLabelText("Retry bank.csv"));
    await waitFor(() => expect(mockUpload).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mockInvalidate).toHaveBeenCalledWith({ queryKey: ["mobile", "files", "owner", "solar-vale:preview-1", "imports"] }));
  });

  it("aborts the original transport and releases the selection when switching computers", async () => {
    const upload = deferred<void>();
    mockPick.mockResolvedValue([asset]);
    mockUpload.mockReturnValue(upload.promise);
    const view = render(<SelectedDeviceUploadPanel currentPath="imports" computer={computer} />);
    fireEvent.press(screen.getByLabelText("Choose files"));
    await screen.findByText("Uploading…");
    await waitFor(() => expect(mockUpload).toHaveBeenCalledTimes(1));
    const signal = mockUpload.mock.calls[0][4] as AbortSignal;
    expect(signal.aborted).toBe(false);
    view.rerender(<SelectedDeviceUploadPanel currentPath="other" computer={{ handle: "second-computer", runtimeSlot: "main", gatewayPath: "/vm/second-computer" }} />);
    expect(signal.aborted).toBe(true);
    expect(mockCleanup).toHaveBeenCalledTimes(1);
    expect(mockCleanup).toHaveBeenCalledWith(asset);
    expect(screen.queryByText("bank.csv")).toBeNull();
    await act(async () => { upload.resolve(undefined); });
    expect(mockUpload).toHaveBeenCalledTimes(1);
    expect(mockInvalidate).not.toHaveBeenCalled();
    expect(screen.getByText("Upload to second-computer")).toBeTruthy();
  });

  it("releases a late system-picker result after closing the panel without uploading", async () => {
    const picker = deferred<typeof asset[]>();
    mockPick.mockReturnValue(picker.promise);
    const view = render(<SelectedDeviceUploadPanel currentPath="imports" computer={computer} />);
    fireEvent.press(screen.getByLabelText("Choose photos"));
    expect(mockPick).toHaveBeenCalledWith("photos");
    expect(screen.getByLabelText("Selecting files")).toBeTruthy();
    view.unmount();
    await act(async () => { picker.resolve([asset]); });
    expect(mockCleanup).toHaveBeenCalledTimes(1);
    expect(mockCleanup).toHaveBeenCalledWith(asset);
    expect(mockGetToken).not.toHaveBeenCalled();
    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockInvalidate).not.toHaveBeenCalled();
  });

  it("does not start an upload when authentication resolves after panel closure", async () => {
    const authentication = deferred<string>();
    mockGetToken.mockReturnValue(authentication.promise);
    mockPick.mockResolvedValue([asset]);
    const view = render(<SelectedDeviceUploadPanel currentPath="imports" computer={computer} />);
    fireEvent.press(screen.getByLabelText("Choose files"));
    await waitFor(() => expect(mockGetToken).toHaveBeenCalledTimes(1));
    expect(mockUpload).not.toHaveBeenCalled();
    view.unmount();
    await act(async () => { authentication.resolve("owner-token"); });
    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockInvalidate).not.toHaveBeenCalled();
    expect(mockCleanup).toHaveBeenCalledTimes(1);
    expect(mockCleanup).toHaveBeenCalledWith(asset);
  });
});
