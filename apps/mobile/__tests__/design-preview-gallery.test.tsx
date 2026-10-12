import { cleanup, fireEvent, render, screen } from "@testing-library/react-native";
import { StyleSheet as NativeStyleSheet } from "react-native";

import { DesignPreview } from "../dev/design-preview/DesignPreview";

const mockSetParams = jest.fn();

jest.mock("expo-router", () => ({
  useRouter: () => ({ setParams: mockSetParams }),
}));

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 62, right: 0, bottom: 34, left: 0 }),
}));

describe("design preview gallery", () => {
  afterEach(() => {
    cleanup();
    jest.clearAllMocks();
  });

  it("shows a section for every shared component", () => {
    render(<DesignPreview frame="components" />);

    for (const heading of [
      "Buttons",
      "Chips",
      "Text field",
      "Search field",
      "Top bar",
      "Item rows",
      "Sheet",
      "Status dots",
      "Count badges",
      "Icon tiles",
      "Agent mascot",
      "Provider logos",
      "Rabbit mark",
    ]) {
      expect(screen.getByRole("header", { name: heading })).toBeTruthy();
    }
  });

  it("sits on the background colour inside the safe area with a 20pt margin", () => {
    render(<DesignPreview frame="components" />);

    const scroll = screen.getByTestId("design-preview-components");
    expect(NativeStyleSheet.flatten(scroll.props.style)).toMatchObject({ backgroundColor: "#FFFEFC" });
    expect(NativeStyleSheet.flatten(scroll.props.contentContainerStyle)).toMatchObject({
      paddingHorizontal: 20,
      paddingTop: 62,
      paddingBottom: 34 + 24,
    });
  });

  it("shows every loading placeholder in the loading frame", () => {
    render(<DesignPreview frame="loading" />);

    for (const heading of ["List rows", "Grid tiles", "Chat rows", "A single value"]) {
      expect(screen.getByRole("header", { name: heading })).toBeTruthy();
    }
    expect(screen.getAllByTestId("list-row-skeleton")).toHaveLength(2);
    expect(screen.getAllByTestId("grid-tile-skeleton")).toHaveLength(3);
    expect(screen.getAllByTestId("recent-chat-skeleton-row")).toHaveLength(3);
    expect(screen.getByTestId("loading-frame-value")).toBeTruthy();
  });

  it("lists the available frames for a frame it does not know", () => {
    render(<DesignPreview frame="nope" />);

    expect(screen.queryByTestId("design-preview-components")).toBeNull();
    fireEvent.press(screen.getByRole("button", { name: "components" }));
    expect(mockSetParams).toHaveBeenCalledWith({ frame: "components" });
  });

  it("lists the available frames when no frame is given", () => {
    render(<DesignPreview frame={undefined} />);

    expect(screen.getByRole("button", { name: "components" })).toBeTruthy();
  });
});
