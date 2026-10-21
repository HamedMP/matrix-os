import type { CanonicalChatDetailResponse } from "@matrix-os/contracts";
import { cleanup, render, screen } from "@testing-library/react-native";

import { ComputerPhoto } from "../components/chat/ComputerPhoto";
import type { ComputerPhotoRequest } from "../components/chat/MessageAttachments";
import { UserMessage } from "../components/chat/UserMessage";
import { buildTranscript, withLocalAttachments } from "../lib/canonical-chat-transcript";
import { pickFiles, pickPhotos } from "../lib/chat-attachment-picker";
import { chatAttachmentPart, type ComposerAttachment } from "../lib/chat-attachments";

jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));

const mockLaunchImageLibrary = jest.fn();
const mockPickFile = jest.fn();
jest.mock("expo-image-picker", () => ({
  launchImageLibraryAsync: (...args: unknown[]) => mockLaunchImageLibrary(...args),
}));
jest.mock("expo-image-manipulator", () => ({
  ImageManipulator: { manipulate: jest.fn() },
  SaveFormat: { JPEG: "jpeg" },
}));
jest.mock("expo-file-system", () => ({
  File: class {
    static pickFileAsync(...args: unknown[]) { return mockPickFile(...args); }
  },
}));

const mockUseComputerFilePreview = jest.fn((path: string) => ({
  isPending: false,
  preview: { kind: "image", uri: `https://app.matrix-os.com/vm/alice/files/${path}`, authorization: "Bearer clerk-token" },
}));
jest.mock("@/lib/queries/use-computer-file-preview", () => ({
  useComputerFilePreview: (path: string) => mockUseComputerFilePreview(path),
}));

/** As a screen that can reach the computer draws a photo from it. */
const fromComputer = (photo: ComputerPhotoRequest) => <ComputerPhoto {...photo} />;

/**
 * The message as the app has it after a restart: the computer's copy, with
 * nothing remembered of where its attachments were on the phone.
 */
function afterRestart(sent: ComposerAttachment) {
  const detail = {
    record: { chat: { id: "chat_1" } },
    runs: [],
    turns: [],
    activities: [],
    messages: [{
      id: "msg_1",
      chatId: "chat_1",
      role: "user",
      state: "committed",
      seq: 1,
      parts: [chatAttachmentPart(sent)],
      createdAt: "2026-10-13T00:00:00.000Z",
    }],
  } as unknown as CanonicalChatDetailResponse;
  return withLocalAttachments(buildTranscript(detail), {})[0]!;
}

describe("a sent photo after the app is started again", () => {
  afterEach(() => {
    cleanup();
    jest.clearAllMocks();
  });

  it("is still drawn as a photo when the library named it without an ending", async () => {
    mockLaunchImageLibrary.mockResolvedValue({
      canceled: false,
      assets: [{
        uri: "content://media/picker/0/1000012345", width: 1_200, height: 900, fileName: "1000012345", fileSize: 300_000, mimeType: "image/png",
      }],
    });
    const [sent] = (await pickPhotos(8))!.attachments;

    const message = afterRestart(sent!);
    render(<UserMessage text="" attachments={message.attachments} renderComputerPhoto={fromComputer} />);

    expect(message.attachments).toEqual([{
      id: `mobile_upload_${sent!.id}`,
      label: "1000012345.png",
      kind: "image",
      path: `temporary/desktop-chat/${sent!.id}-1000012345.png`,
    }]);
    expect(mockUseComputerFilePreview).toHaveBeenCalledWith(`temporary/desktop-chat/${sent!.id}-1000012345.png`);
    expect(screen.getByLabelText("1000012345.png").props.source).toEqual({
      uri: `https://app.matrix-os.com/vm/alice/files/temporary/desktop-chat/${sent!.id}-1000012345.png`,
      headers: { Authorization: "Bearer clerk-token" },
    });
    expect(screen.queryByTestId("message-file")).toBeNull();
  });

  it("is still drawn as a photo when it was a picture file with no ending", async () => {
    mockPickFile.mockResolvedValue({
      canceled: false,
      result: [{ uri: "file:///tmp/scan", name: "scan", type: "image/jpeg", size: 90_000 }],
    });
    const [sent] = (await pickFiles(8, ["image", "file"]))!.attachments;

    const message = afterRestart(sent!);
    render(<UserMessage text="" attachments={message.attachments} renderComputerPhoto={fromComputer} />);

    expect(mockUseComputerFilePreview).toHaveBeenCalledWith(`temporary/desktop-chat/${sent!.id}-scan.jpg`);
    expect(screen.getByLabelText("scan.jpg").props.source).toMatchObject({
      uri: `https://app.matrix-os.com/vm/alice/files/temporary/desktop-chat/${sent!.id}-scan.jpg`,
    });
    expect(screen.queryByTestId("message-file")).toBeNull();
  });
});
