import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react-native";

import { MatrixAttachmentPicker } from "../components/chat/MatrixAttachmentPicker";
import type { ComposerAttachment } from "../lib/chat-attachments";
import type { FileEntry } from "../lib/requests/files";

jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 62, right: 0, bottom: 34, left: 0 }),
}));

const mockStage = jest.fn();
const mockRefresh = jest.fn();
let mockError = false;
let mockEntries: FileEntry[];
jest.mock("@/lib/matrix-attachment", () => ({
  stageMatrixAttachment: (...args: unknown[]) => mockStage(...args),
  discardMatrixAttachment: jest.fn(),
}));
jest.mock("@/lib/queries/use-active-gateway", () => ({
  useActiveGateway: () => ({
    ready: true,
    userId: "owner",
    gatewayUrl: "https://matrix.test/vm/computer",
    computer: { gatewayPath: "/vm/computer" },
    session: async () => ({ token: "test-token", gatewayUrl: "https://matrix.test/vm/computer" }),
  }),
}));
jest.mock("@/lib/queries/use-computer-directory", () => ({
  useComputerDirectory: (path: string) => ({
    entries: path ? [{ name: "report.txt", type: "file", size: 1024, gitStatus: null }] : mockEntries,
    computer: { gatewayPath: "/vm/computer" },
    isPending: false,
    isError: mockError,
    refresh: mockRefresh,
  }),
}));

function openPicker() {
  const onAdd = jest.fn();
  render(<MatrixAttachmentPicker
    binding={{ scope: "owner:computer:chat", gatewayUrl: "https://matrix.test/vm/computer" }}
    kinds={["image", "file"]} room={8} attachments={[]} onBack={jest.fn()} onAdd={onAdd}
  />);
  return { onAdd };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockError = false;
  mockEntries = [
    { name: "reports", type: "directory", gitStatus: null },
    { name: "memo.txt", type: "file", size: 2048, gitStatus: null },
    { name: "photo.png", type: "file", size: 512, gitStatus: null },
  ];
});
afterEach(cleanup);

it("shows file sizes and folder context before the person chooses an attachment", () => {
  openPicker();
  expect(screen.getByText("2 KB")).toBeTruthy();
  expect(screen.getByText("512 B")).toBeTruthy();
  expect(screen.getByText("Folder")).toBeTruthy();
  expect(screen.getByText("3 items")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Open reports" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Attach memo.txt" })).toBeTruthy();
});

it("lets the person return to Matrix home directly from a folder breadcrumb", () => {
  openPicker();
  fireEvent.press(screen.getByRole("button", { name: "Open reports" }));
  expect(screen.getByRole("button", { name: "Attach report.txt" })).toBeTruthy();
  expect(screen.getByText("1 item")).toBeTruthy();
  fireEvent.press(screen.getByRole("button", { name: "Matrix home" }));
  expect(screen.getByRole("button", { name: "Attach memo.txt" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Attach report.txt" })).toBeNull();
});

it("keeps the selected file visible with progress and prevents another selection while reading", async () => {
  let finish!: (attachment: ComposerAttachment) => void;
  mockStage.mockImplementation(() => new Promise<ComposerAttachment>(resolve => { finish = resolve; }));
  const { onAdd } = openPicker();
  fireEvent.press(screen.getByRole("button", { name: "Attach memo.txt" }));
  await waitFor(() => expect(mockStage).toHaveBeenCalledTimes(1));
  expect(screen.getByLabelText("Reading memo.txt")).toBeTruthy();
  fireEvent.press(screen.getByRole("button", { name: "Attach photo.png" }));
  expect(mockStage).toHaveBeenCalledTimes(1);
  const attachment: ComposerAttachment = {
    id: "att_00000000000000000000000000000000", uri: "file:///memo", name: "memo.txt",
    mimeType: "text/plain", kind: "file", sizeBytes: 2048,
  };
  await act(async () => { finish(attachment); });
  expect(onAdd).toHaveBeenCalledWith(attachment);
  expect(screen.queryByLabelText("Reading memo.txt")).toBeNull();
});

it("offers an actionable retry when the folder cannot be loaded", () => {
  mockError = true;
  openPicker();
  expect(screen.getByText("Files unavailable")).toBeTruthy();
  fireEvent.press(screen.getByRole("button", { name: "Try again" }));
  expect(mockRefresh).toHaveBeenCalledTimes(1);
});
