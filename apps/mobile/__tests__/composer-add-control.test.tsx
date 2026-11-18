import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react-native";
import { Alert } from "react-native";

import { ComposerAddControl, type ComposerAddControlProps } from "../components/chat/ComposerAddControl";
import { Icon } from "../components/ui/Icon";
import { AddIcon } from "../components/ui/icons";
import type { ComposerAttachment } from "../lib/chat-attachments";
import type { ChatSlashEntry } from "../lib/chat-slash-entries";

import { flat } from "./ui-test-utils";

jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 62, right: 0, bottom: 34, left: 0 }),
}));

const mockPickPhotos = jest.fn();
const mockPickFiles = jest.fn();
jest.mock("@/lib/chat-attachment-picker", () => ({
  pickPhotos: (...args: unknown[]) => mockPickPhotos(...args),
  pickFiles: (...args: unknown[]) => mockPickFiles(...args),
}));

let mockSheet: { isPresented: boolean; onDismiss: () => void } = { isPresented: false, onDismiss: () => {} };

// As the native sheet does while it slides away, this one keeps its content
// when it is not presented.
jest.mock("@expo/ui", () => {
  const { View } = jest.requireActual("react-native") as typeof import("react-native");
  return {
    BottomSheet: (props: { children: ReactNode; isPresented: boolean; onDismiss: () => void }) => {
      mockSheet = props;
      return <View testID="expo-bottom-sheet">{props.children}</View>;
    },
    RNHostView: ({ children }: { children: ReactNode }) => children,
  };
});

const photo: ComposerAttachment = {
  id: "att_f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0", uri: "file:///cache/flowers.jpg", name: "flowers.jpg", mimeType: "image/jpeg", kind: "image", sizeBytes: 2_048,
};

const skills: ChatSlashEntry[] = [
  { id: "skill:app-builder", kind: "skill", name: "App builder", description: "Builds a small app", invocation: "/app-builder" },
  { id: "command:review", kind: "command", name: "Review", description: "Reviews the changes", invocation: "/review" },
];

function renderControl(overrides: Partial<ComposerAddControlProps> = {}) {
  const props: ComposerAddControlProps = {
    kinds: ["image", "file"],
    room: 8,
    skills: [],
    onAdd: jest.fn(),
    onInvoke: jest.fn(),
    ...overrides,
  };
  const view = render(<ComposerAddControl {...props} />);
  return { props, ...view };
}

function addButton() {
  return screen.getByRole("button", { name: "Add to message" });
}

function row(label: string) {
  return screen.getByRole("button", { name: new RegExp(`^${label}, `) });
}

function open() {
  fireEvent.press(addButton());
}

describe("the composer's add control", () => {
  let alert: jest.SpyInstance;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    mockSheet = { isPresented: false, onDismiss: () => {} };
    alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    alert.mockRestore();
    warn.mockRestore();
    jest.clearAllMocks();
  });

  it("is a round 44pt plus on the card fill", () => {
    renderControl();

    expect(flat(addButton())).toMatchObject({ width: 44, height: 44, borderRadius: 9999, backgroundColor: "#FAF9F7" });
    expect(addButton().findByType(Icon).props).toMatchObject({ icon: AddIcon, size: 18 });
  });

  it("opens a sheet that offers photos and files", () => {
    renderControl();
    expect(mockSheet.isPresented).toBe(false);

    open();

    expect(mockSheet.isPresented).toBe(true);
    expect(screen.getByRole("header", { name: "Add to message" })).toBeTruthy();
    expect(row("Photos").props.accessibilityLabel).toBe("Photos, Choose from your library");
    expect(row("Files").props.accessibilityLabel).toBe("Files, Browse the files on this phone");
    expect(row("Photos").props.accessibilityState).toMatchObject({ disabled: false });
  });

  it("closes its sheet when pressed again, and opens on what can be attached the next time", () => {
    renderControl({ skills });
    open();
    fireEvent.press(row("Skills and commands"));

    fireEvent.press(addButton());
    expect(mockSheet.isPresented).toBe(false);

    fireEvent.press(addButton());
    expect(mockSheet.isPresented).toBe(true);
    expect(row("Photos")).toBeTruthy();
  });

  it("closes when the sheet is dismissed", () => {
    renderControl();
    open();

    act(() => mockSheet.onDismiss());

    expect(mockSheet.isPresented).toBe(false);
  });

  describe("photos", () => {
    it("adds the chosen photos and closes the sheet", async () => {
      mockPickPhotos.mockResolvedValue({ attachments: [photo], rejections: [] });
      const { props } = renderControl({ room: 5 });
      open();

      fireEvent.press(row("Photos"));

      // Up to what the message can still carry.
      expect(mockPickPhotos).toHaveBeenCalledWith(5);
      await waitFor(() => expect(props.onAdd).toHaveBeenCalledWith([photo]));
      expect(mockSheet.isPresented).toBe(false);
      expect(alert).not.toHaveBeenCalled();
    });

    it("keeps the sheet open, under the library, until something has been chosen", async () => {
      let choose: (picked: unknown) => void = () => {};
      mockPickPhotos.mockReturnValue(new Promise((resolve) => { choose = resolve; }));
      renderControl();
      open();

      fireEvent.press(row("Photos"));

      expect(mockSheet.isPresented).toBe(true);
      // Nothing else can be started from the sheet meanwhile.
      expect(row("Photos").props.accessibilityState).toMatchObject({ disabled: true });
      expect(row("Files").props.accessibilityState).toMatchObject({ disabled: true });
      fireEvent.press(row("Files"));
      expect(mockPickFiles).not.toHaveBeenCalled();

      await act(async () => { choose({ attachments: [photo], rejections: [] }); });
      expect(mockSheet.isPresented).toBe(false);
    });

    it("goes back to the sheet when the person backs out of the library", async () => {
      mockPickPhotos.mockResolvedValue(null);
      const { props } = renderControl();
      open();

      fireEvent.press(row("Photos"));

      await waitFor(() => expect(row("Photos").props.accessibilityState).toMatchObject({ disabled: false }));
      expect(mockSheet.isPresented).toBe(true);
      expect(props.onAdd).not.toHaveBeenCalled();
    });

    it("says what was left out, and still adds the rest", async () => {
      mockPickPhotos.mockResolvedValue({ attachments: [photo], rejections: ["too_large", "too_large"] });
      const { props } = renderControl();
      open();

      fireEvent.press(row("Photos"));

      await waitFor(() => expect(alert).toHaveBeenCalledWith("Not everything was attached", "2 items exceed their attachment size limits."));
      expect(props.onAdd).toHaveBeenCalledWith([photo]);
    });

    it("adds nothing when everything chosen was left out", async () => {
      mockPickPhotos.mockResolvedValue({ attachments: [], rejections: ["unreadable"] });
      const { props } = renderControl();
      open();

      fireEvent.press(row("Photos"));

      await waitFor(() => expect(alert).toHaveBeenCalledWith("Not everything was attached", "1 item could not be read."));
      expect(props.onAdd).not.toHaveBeenCalled();
    });

    it("says so in plain words when the library cannot be opened, without the reason", async () => {
      mockPickPhotos.mockRejectedValue(new Error("PHPickerError at /Users/alice/secret"));
      const { props } = renderControl();
      open();

      fireEvent.press(row("Photos"));

      await waitFor(() => expect(alert).toHaveBeenCalledWith("Could not open your photos", "Try again."));
      expect(props.onAdd).not.toHaveBeenCalled();
      expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
      // The sheet can be used again.
      expect(row("Photos").props.accessibilityState).toMatchObject({ disabled: false });
    });
  });

  describe("files", () => {
    it("adds the chosen files of the kinds the model reads", async () => {
      const notes: ComposerAttachment = { ...photo, id: "att_0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e", name: "notes.txt", mimeType: "text/plain", kind: "file" };
      mockPickFiles.mockResolvedValue({ attachments: [notes], rejections: [] });
      const { props } = renderControl({ kinds: ["file"] });
      open();

      fireEvent.press(row("Files"));

      expect(mockPickFiles).toHaveBeenCalledWith(8, ["file"]);
      await waitFor(() => expect(props.onAdd).toHaveBeenCalledWith([notes]));
      expect(mockSheet.isPresented).toBe(false);
    });

    it("says so when the file browser cannot be opened", async () => {
      mockPickFiles.mockRejectedValue(new Error("no browser"));
      renderControl();
      open();

      fireEvent.press(row("Files"));

      await waitFor(() => expect(alert).toHaveBeenCalledWith("Could not open your files", "Try again."));
    });
  });

  describe("what the selected model reads", () => {
    it("offers no photos for a model that reads only files", () => {
      renderControl({ kinds: ["file"] });
      open();

      expect(row("Photos").props.accessibilityLabel).toBe("Photos, The selected model cannot read photos");
      expect(row("Photos").props.accessibilityState).toMatchObject({ disabled: true });
      expect(row("Files").props.accessibilityState).toMatchObject({ disabled: false });

      fireEvent.press(row("Photos"));
      expect(mockPickPhotos).not.toHaveBeenCalled();
    });

    it("offers neither for a model that reads no attachments", () => {
      renderControl({ kinds: [] });
      open();

      expect(row("Photos").props.accessibilityState).toMatchObject({ disabled: true });
      expect(row("Files").props.accessibilityLabel).toBe("Files, The selected model cannot read files");
      expect(row("Files").props.accessibilityState).toMatchObject({ disabled: true });
    });

    it("offers neither once the message has all it can carry", () => {
      renderControl({ room: 0 });
      open();

      expect(row("Photos").props.accessibilityLabel).toBe("Photos, This message has all it can carry");
      expect(row("Photos").props.accessibilityState).toMatchObject({ disabled: true });
      expect(row("Files").props.accessibilityState).toMatchObject({ disabled: true });
    });
  });

  describe("skills and commands", () => {
    it("has no row for them when the model has none", () => {
      renderControl();
      open();

      expect(screen.queryByRole("button", { name: /^Skills and commands/ })).toBeNull();
    });

    it("lists the model's skills and commands on a page of their own", () => {
      renderControl({ skills });
      open();
      expect(row("Skills and commands").props.accessibilityLabel).toBe("Skills and commands, 2 for the selected model");

      fireEvent.press(row("Skills and commands"));

      expect(screen.getByRole("header", { name: "Skills and commands" })).toBeTruthy();
      const list = screen.getByTestId("add-menu-skill-list");
      expect(within(list).getAllByRole("button").map((button) => button.props.accessibilityLabel)).toEqual([
        "/app-builder, Builds a small app",
        "/review, Reviews the changes",
      ]);
      expect(screen.queryByRole("button", { name: /^Photos/ })).toBeNull();
    });

    it("puts the chosen one in the message and closes the sheet", () => {
      const { props } = renderControl({ skills });
      open();
      fireEvent.press(row("Skills and commands"));

      fireEvent.press(screen.getByRole("button", { name: "/review, Reviews the changes" }));

      expect(props.onInvoke).toHaveBeenCalledWith("/review");
      expect(mockSheet.isPresented).toBe(false);
    });

    it("goes back to what can be attached, and opens on that again next time", () => {
      renderControl({ skills });
      open();
      fireEvent.press(row("Skills and commands"));

      fireEvent.press(screen.getByRole("button", { name: "Back" }));
      expect(row("Photos")).toBeTruthy();

      fireEvent.press(row("Skills and commands"));
      act(() => mockSheet.onDismiss());
      open();
      expect(row("Photos")).toBeTruthy();
    });

    it("says how many there are, one or more", () => {
      renderControl({ skills: skills.slice(0, 1) });
      open();

      expect(row("Skills and commands").props.accessibilityLabel).toBe("Skills and commands, 1 for the selected model");
    });
  });

  describe("while there is nobody to send as", () => {
    it("cannot be opened", () => {
      renderControl({ disabled: true });

      expect(addButton().props.accessibilityState).toMatchObject({ disabled: true });
      open();
      expect(mockSheet.isPresented).toBe(false);
    });

    it("closes its sheet when it stops being usable, and does not bring it back", () => {
      const { props, rerender } = renderControl({ skills });
      open();
      expect(mockSheet.isPresented).toBe(true);

      rerender(<ComposerAddControl {...props} disabled />);
      expect(mockSheet.isPresented).toBe(false);
      // What the closing sheet still shows does nothing.
      fireEvent.press(row("Photos"));
      expect(mockPickPhotos).not.toHaveBeenCalled();

      rerender(<ComposerAddControl {...props} />);
      expect(mockSheet.isPresented).toBe(false);
    });
  });
});
