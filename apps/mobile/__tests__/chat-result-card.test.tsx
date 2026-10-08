import { cleanup, fireEvent, render, screen } from "@testing-library/react-native";

import { ResultCard } from "../components/chat/ResultCard";
import { IconTile } from "../components/ui/IconTile";
import { AppsTabIcon } from "../components/ui/icons";

import { flat } from "./ui-test-utils";

const app = { slug: "habit-tracker", name: "Habit tracker", detail: "App · Productivity" };

describe("ResultCard", () => {
  afterEach(cleanup);

  it("is a hairline-bordered row: icon tile, two lines of text, Open", () => {
    render(<ResultCard app={app} onOpen={jest.fn()} />);

    expect(flat(screen.getByTestId("result-card"))).toMatchObject({
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      borderWidth: 1,
      borderColor: "#F3F2F2",
      borderRadius: 14,
      paddingHorizontal: 14,
      paddingVertical: 12,
    });
    expect(screen.UNSAFE_getByType(IconTile).props).toMatchObject({ icon: AppsTabIcon, size: 36, tone: "subtle" });
  });

  it("names the app in the medium 14pt style over a subtle 12pt second line", () => {
    render(<ResultCard app={app} onOpen={jest.fn()} />);

    const name = screen.getByText("Habit tracker");
    expect(name.props.numberOfLines).toBe(1);
    expect(flat(name)).toMatchObject({
      fontFamily: "Geist_500Medium",
      fontSize: 14,
      lineHeight: 20,
      color: "#242323",
    });
    expect(flat(screen.getByText("App · Productivity"))).toMatchObject({
      fontFamily: "Geist_400Regular",
      fontSize: 12,
      lineHeight: 17,
      color: "#635F5F",
    });
  });

  it("opens the app from an outline button named after it", () => {
    const onOpen = jest.fn();
    render(<ResultCard app={app} onOpen={onOpen} />);

    const open = screen.getByRole("button", { name: "Open Habit tracker" });
    expect(screen.getByText("Open")).toBeTruthy();
    expect(flat(open)).toMatchObject({ height: 44, borderWidth: 1, backgroundColor: "#FFFFFF" });

    fireEvent.press(open);

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(app);
  });
});
