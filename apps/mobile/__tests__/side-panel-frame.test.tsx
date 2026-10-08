import { cleanup, render, screen, within } from "@testing-library/react-native";
import { Text } from "react-native";

import { SidePanelFrame, SidePanelOverScreen } from "../dev/design-preview/panel";

import { flat } from "./ui-test-utils";

describe("side panel preview frames", () => {
  afterEach(cleanup);

  it("shows the panel alone, 330pt wide, with the content of frame C2", () => {
    render(<SidePanelFrame />);

    expect(flat(screen.getByTestId("side-panel-frame"))).toMatchObject({ width: 330, flex: 1 });
    expect(screen.getAllByRole("header").map((header) => header.props.children)).toEqual([
      "Chats", "Needs you", "Recent",
    ]);
    expect(screen.getAllByRole("button").map((button) => button.props.accessibilityLabel)).toEqual([
      "New chat",
      "Projects, 3 projects",
      "Weekly report, needs you, Approve before sending, 1h",
      "Sales prep this week, Both briefs are ready, Yesterday",
      "Q4 planning, Draft shared with the team, Mon",
    ]);
    expect(within(screen.getByTestId("side-panel-needs-you")).getByText("1")).toBeTruthy();
    expect(screen.getByLabelText("Search chats").props.value).toBe("");
  });

  it("lays the panel over a screen for frame C2, with the scrim between them and the panel's shadow", () => {
    render(
      <SidePanelOverScreen>
        <Text>What can I help with?</Text>
      </SidePanelOverScreen>,
    );

    expect(screen.getByText("What can I help with?")).toBeTruthy();
    expect(flat(screen.getByTestId("side-panel-frame-scrim"))).toMatchObject({
      position: "absolute",
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      backgroundColor: "rgba(0, 0, 0, 0.3)",
    });
    expect(flat(screen.getByTestId("side-panel-frame-raised"))).toMatchObject({
      position: "absolute",
      top: 0,
      bottom: 0,
      left: 0,
      boxShadow: "8px 0 24px rgba(0, 0, 0, 0.12)",
    });
    expect(within(screen.getByTestId("side-panel-frame-raised")).getByText("Weekly report")).toBeTruthy();
  });
});
