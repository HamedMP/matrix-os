import { cleanup, fireEvent, render, screen, within } from "@testing-library/react-native";

import { ComputerPhoto } from "../components/chat/ComputerPhoto";
import type { ComputerPhotoRequest } from "../components/chat/MessageAttachments";
import { UserMessage } from "../components/chat/UserMessage";
import type { TranscriptAttachment } from "../lib/chat-attachments";

import { flat } from "./ui-test-utils";

jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));

let mockPreview: { preview?: unknown; isPending: boolean } = { isPending: false };
const mockUseComputerFilePreview = jest.fn((_path: string) => mockPreview);
jest.mock("@/lib/queries/use-computer-file-preview", () => ({
  useComputerFilePreview: (path: string) => mockUseComputerFilePreview(path),
}));

const place = "temporary/desktop-chat/att_a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4-flowers.jpg";
const onComputer: TranscriptAttachment = { id: "a", label: "flowers.jpg", kind: "image", path: place };
const onPhone: TranscriptAttachment = { ...onComputer, localUri: "file:///cache/flowers.jpg" };
const notes: TranscriptAttachment = { id: "n", label: "notes.txt", kind: "file", path: "temporary/desktop-chat/att_0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e-notes.txt" };

/** As a screen that can reach the computer draws a photo from it. */
const fromComputer = (photo: ComputerPhotoRequest) => <ComputerPhoto {...photo} />;

const computerCopy = {
  kind: "image",
  uri: "https://app.matrix-os.com/vm/alice/files/temporary/desktop-chat/att_a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4-flowers.jpg",
  authorization: "Bearer clerk-token",
};

describe("a sent message's attachments", () => {
  beforeEach(() => {
    mockPreview = { isPending: false, preview: computerCopy };
  });

  afterEach(() => {
    cleanup();
    jest.clearAllMocks();
  });

  it("leaves a message with none as the bubble it was", () => {
    render(<UserMessage text="Ship it" />);

    expect(screen.queryByTestId("message-attachments")).toBeNull();
    expect(flat(screen.getByTestId("user-message"))).toMatchObject({ maxWidth: "80%", alignSelf: "flex-end" });
    expect(screen.getByText("Ship it")).toBeTruthy();
  });

  it("shows them above the text, against the right edge", () => {
    render(<UserMessage text="What is this?" attachments={[onPhone]} />);

    const group = screen.getByTestId("user-message-with-attachments");
    expect(flat(group)).toMatchObject({ alignItems: "flex-end" });
    expect(flat(screen.getByTestId("message-attachments"))).toMatchObject({
      maxWidth: "80%", flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end",
    });
    const order = within(group).getAllByLabelText(/flowers\.jpg/).length;
    expect(order).toBe(1);
    expect(within(group).getByText("What is this?")).toBeTruthy();
  });

  it("draws no empty bubble under attachments sent with no text", () => {
    render(<UserMessage text="" attachments={[onPhone]} />);

    expect(screen.queryByTestId("user-message")).toBeNull();
    expect(screen.getByLabelText("flowers.jpg")).toBeTruthy();
  });

  it("shows a photo sent from this phone from the phone's own copy", () => {
    render(<UserMessage text="" attachments={[onPhone]} />);

    expect(screen.getByLabelText("flowers.jpg").props.source).toEqual({ uri: "file:///cache/flowers.jpg" });
    expect(mockUseComputerFilePreview).not.toHaveBeenCalled();
  });

  it("shows any other photo from the computer, signed in as the person", () => {
    render(<UserMessage text="" attachments={[onComputer]} renderComputerPhoto={fromComputer} />);

    expect(mockUseComputerFilePreview).toHaveBeenCalledWith(place);
    expect(screen.getByLabelText("flowers.jpg").props.source).toEqual({
      uri: computerCopy.uri,
      headers: { Authorization: "Bearer clerk-token" },
    });
  });

  it("falls back to the computer's copy when the phone's is gone", () => {
    render(<UserMessage text="" attachments={[onPhone]} renderComputerPhoto={fromComputer} />);

    fireEvent(screen.getByLabelText("flowers.jpg"), "error");

    expect(screen.getByLabelText("flowers.jpg").props.source).toMatchObject({ uri: computerCopy.uri });
  });

  it("holds the photo's place while the computer's copy is being asked for", () => {
    mockPreview = { isPending: true };
    render(<UserMessage text="" attachments={[onComputer]} renderComputerPhoto={fromComputer} />);

    expect(flat(screen.getByTestId("message-photo-loading"))).toMatchObject({ width: 200, height: 200 });
  });

  it("names a photo it cannot show instead", () => {
    mockPreview = { isPending: false, preview: undefined };
    render(<UserMessage text="" attachments={[onComputer]} renderComputerPhoto={fromComputer} />);
    expect(within(screen.getByTestId("message-file")).getByText("flowers.jpg")).toBeTruthy();

    cleanup();
    mockPreview = { isPending: false, preview: computerCopy };
    render(<UserMessage text="" attachments={[onComputer]} renderComputerPhoto={fromComputer} />);
    fireEvent(screen.getByLabelText("flowers.jpg"), "error");
    expect(within(screen.getByTestId("message-file")).getByText("flowers.jpg")).toBeTruthy();
  });

  it("names a photo whose file is not one the app can show, without asking the computer for it", () => {
    render(
      <UserMessage
        text=""
        attachments={[{ id: "h", label: "IMG_1.heic", kind: "image", path: "temporary/desktop-chat/x-IMG_1.heic" }]}
        renderComputerPhoto={fromComputer}
      />,
    );

    expect(within(screen.getByTestId("message-file")).getByText("IMG_1.heic")).toBeTruthy();
    expect(mockUseComputerFilePreview).not.toHaveBeenCalled();
  });

  it("names a photo that the message gives no place for", () => {
    render(<UserMessage text="" attachments={[{ id: "x", label: "pasted.png", kind: "image" }]} renderComputerPhoto={fromComputer} />);

    expect(within(screen.getByTestId("message-file")).getByText("pasted.png")).toBeTruthy();
    expect(mockUseComputerFilePreview).not.toHaveBeenCalled();
  });

  it("names a photo on the computer where nothing is given to read the computer with", () => {
    render(<UserMessage text="" attachments={[onComputer]} />);

    expect(within(screen.getByTestId("message-file")).getByText("flowers.jpg")).toBeTruthy();
    expect(mockUseComputerFilePreview).not.toHaveBeenCalled();
  });

  it("hands a photo on the computer to what the screen gave it, with the size it is drawn at", () => {
    const renderComputerPhoto = jest.fn(() => null);
    render(<UserMessage text="" attachments={[onComputer]} renderComputerPhoto={renderComputerPhoto} />);

    expect(renderComputerPhoto).toHaveBeenCalledTimes(1);
    const [photo] = renderComputerPhoto.mock.calls[0] as unknown as [ComputerPhotoRequest];
    expect(photo).toMatchObject({ path: place, label: "flowers.jpg" });
    expect(flat({ props: { style: photo.style } })).toMatchObject({ width: 200, height: 200 });
  });

  it("shows a file by its name", () => {
    render(<UserMessage text="Here are my notes" attachments={[notes]} />);

    const chip = screen.getByTestId("message-file");
    expect(chip.props.accessibilityLabel).toBe("notes.txt");
    expect(within(chip).getByText("notes.txt")).toBeTruthy();
    expect(mockUseComputerFilePreview).not.toHaveBeenCalled();
  });

  it("shows a photo alone larger than photos side by side", () => {
    render(<UserMessage text="" attachments={[onPhone]} />);
    expect(flat(screen.getByLabelText("flowers.jpg"))).toMatchObject({ width: 200, height: 200 });

    cleanup();
    render(<UserMessage text="" attachments={[onPhone, { ...onPhone, id: "b", label: "falls.jpg" }]} />);
    expect(flat(screen.getByLabelText("flowers.jpg"))).toMatchObject({ width: 120, height: 120 });
    expect(flat(screen.getByLabelText("falls.jpg"))).toMatchObject({ width: 120, height: 120 });
  });
});
