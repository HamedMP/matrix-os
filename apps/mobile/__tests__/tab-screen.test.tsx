const mockBack = jest.fn();
const mockReplace = jest.fn();
let mockCanGoBack = true;

jest.mock("expo-router", () => ({
  useRouter: () => ({ back: mockBack, replace: mockReplace, canGoBack: () => mockCanGoBack }),
}));

import { cleanup, fireEvent, render, screen } from "@testing-library/react-native";
import { Text } from "react-native";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";

import { BackTopBar } from "../components/shell/BackTopBar";
import { TabScreen } from "../components/shell/TabScreen";
import { Icon } from "../components/ui/Icon";
import { BackIcon } from "../components/ui/icons";

import { flat } from "./ui-test-utils";

afterEach(cleanup);

describe("TabScreen", () => {
  it("fills the tab on the background colour and starts its content below the status bar", () => {
    render(
      <SafeAreaInsetsContext.Provider value={{ top: 62, right: 0, bottom: 34, left: 0 }}>
        <TabScreen testID="screen"><Text>Content</Text></TabScreen>
      </SafeAreaInsetsContext.Provider>,
    );

    const style = flat(screen.getByTestId("screen"));
    expect(style).toMatchObject({ flex: 1, backgroundColor: "#FFFEFC", paddingTop: 62 });
    // The tab bar beneath it owns the bottom inset.
    expect(style.paddingBottom).toBeUndefined();
    expect(screen.getByText("Content")).toBeTruthy();
  });

  it("adds nothing on a device without a top inset", () => {
    render(<TabScreen testID="screen"><Text>Content</Text></TabScreen>);

    expect(flat(screen.getByTestId("screen")).paddingTop).toBe(0);
  });
});

describe("BackTopBar", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCanGoBack = true;
  });

  it("is a top bar with a 44pt back button, a 22pt icon and no title", () => {
    render(<BackTopBar fallbackHref="/apps" />);

    const button = screen.getByRole("button", { name: "Back" });
    expect(flat(button)).toMatchObject({ width: 44, height: 44 });
    expect(screen.UNSAFE_getByType(Icon).props).toMatchObject({ icon: BackIcon, size: 22 });
    expect(screen.queryByRole("header")).toBeNull();
  });

  it("goes back to the screen beneath", () => {
    render(<BackTopBar fallbackHref="/apps" />);

    fireEvent.press(screen.getByRole("button", { name: "Back" }));

    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("opens the fallback instead when a link opened the screen with nothing beneath it", () => {
    mockCanGoBack = false;
    render(<BackTopBar fallbackHref="/(drawer)" />);

    fireEvent.press(screen.getByRole("button", { name: "Back" }));

    expect(mockReplace).toHaveBeenCalledWith("/(drawer)");
    expect(mockBack).not.toHaveBeenCalled();
  });
});
