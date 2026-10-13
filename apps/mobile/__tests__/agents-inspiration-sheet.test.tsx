import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react-native";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";

import { InspirationSheet, type InspirationSheetProps } from "../components/agents/InspirationSheet";
import type { AgentInspiration } from "../components/agents/agent-inspirations.generated";
import { AgentMascot } from "../components/ui/AgentMascot";

import { flat } from "./ui-test-utils";

let mockSheet: { isPresented: boolean; onDismiss: () => void } = { isPresented: false, onDismiss: () => {} };

// Unlike the real sheet's mock elsewhere, this one keeps its content when it is
// not presented, as the native sheet does while it slides away.
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

const followUps: AgentInspiration = {
  id: "call-follow-ups",
  name: "Call Follow-Ups",
  categories: ["Sales", "Marketing"],
  description: "Turns a call into the follow-up email, the CRM note and the next steps. Never sends without you.",
  skills: ["Draft the follow-up"],
  integrations: ["Gmail"],
};
const uncategorized: AgentInspiration = {
  id: "overheard",
  name: "Overheard",
  categories: [],
  description: "Collects the best lines of the week.",
  skills: [],
  integrations: [],
};

function sheet(overrides: Partial<InspirationSheetProps> = {}) {
  const props: InspirationSheetProps = {
    inspiration: followUps,
    onBuildInChat: jest.fn(),
    onClose: jest.fn(),
    ...overrides,
  };
  const element = (
    <SafeAreaInsetsContext.Provider value={{ top: 62, right: 0, bottom: 34, left: 0 }}>
      <InspirationSheet {...props} />
    </SafeAreaInsetsContext.Provider>
  );
  return { props, element };
}

function renderSheet(overrides: Partial<InspirationSheetProps> = {}) {
  const { props, element } = sheet(overrides);
  return { props, ...render(element) };
}

describe("inspiration sheet", () => {
  afterEach(cleanup);

  it("stays closed until an inspiration is chosen", () => {
    renderSheet({ inspiration: null });

    expect(mockSheet.isPresented).toBe(false);
    expect(screen.queryByRole("button", { name: "Build in chat" })).toBeNull();
  });

  it("is laid out like the template setup sheet: grabber first, 20pt sides, 14pt between blocks", () => {
    renderSheet();

    const body = screen.getByTestId("inspiration-sheet-body");
    expect(flat(body)).toMatchObject({ paddingHorizontal: 20, paddingBottom: 34 + 10, gap: 14 });
    expect(flat(body).paddingTop).toBeUndefined();
    const first = body.children[0];
    expect(typeof first === "string" ? first : first.props.testID).toBe("inspiration-sheet-grabber");
  });

  it("heads the sheet with the 48pt mascot in its first category's colour, the name over its categories", () => {
    renderSheet();

    const head = screen.getByTestId("inspiration-sheet-head");
    expect(within(head).UNSAFE_getByType(AgentMascot).props).toMatchObject({
      id: "call-follow-ups",
      name: "Call Follow-Ups",
      category: "Sales",
      size: 48,
    });
    expect(within(head).getByRole("header", { name: "Call Follow-Ups" })).toBeTruthy();
    expect(within(head).getByText("Sales · Marketing")).toBeTruthy();
  });

  it("leaves the line under the name out for an inspiration without a category", () => {
    renderSheet({ inspiration: uncategorized });

    const head = screen.getByTestId("inspiration-sheet-head");
    expect(within(head).UNSAFE_getByType(AgentMascot).props.category).toBeUndefined();
    expect(within(head).getByRole("header", { name: "Overheard" })).toBeTruthy();
    expect(within(head).queryByText(/·/)).toBeNull();
  });

  it("shows the whole description, which the gallery's row cuts short", () => {
    renderSheet();

    const description = screen.getByText(followUps.description);
    expect(description.props.numberOfLines).toBeUndefined();
    expect(flat(description)).toMatchObject({
      fontFamily: "Geist_400Regular",
      fontSize: 15,
      lineHeight: 22,
      color: "#242323",
    });
  });

  it("scrolls a long description within two fifths of the window, so the button under it stays in reach", () => {
    renderSheet();

    const area = screen.getByTestId("inspiration-sheet-description");
    expect(flat(area)).toMatchObject({ flexGrow: 0, maxHeight: Math.round(1334 * 0.4) });
    expect(area.props.alwaysBounceVertical).toBe(false);
    expect(within(area).getByText(followUps.description)).toBeTruthy();
    // The head and the button stay put while the description scrolls.
    expect(within(area).queryByRole("button", { name: "Build in chat" })).toBeNull();
    expect(within(area).queryByRole("header", { name: "Call Follow-Ups" })).toBeNull();
    expect(within(screen.getByTestId("inspiration-sheet-body")).getByRole("button", { name: "Build in chat" })).toBeTruthy();
  });

  it("builds the agent in chat from a filled, large, full-width button", () => {
    const { props } = renderSheet();

    const build = screen.getByRole("button", { name: "Build in chat" });
    expect(flat(build)).toMatchObject({ height: 48, alignSelf: "stretch", backgroundColor: "#171717" });
    fireEvent.press(build);

    expect(props.onBuildInChat).toHaveBeenCalledTimes(1);
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("has nothing to create with: an inspiration has no template on the computer", () => {
    renderSheet();

    expect(screen.queryByLabelText("Name")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create agent" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Set up in chat instead" })).toBeNull();
  });

  it("closes from its close button and when it is dragged away", () => {
    const { props } = renderSheet();

    fireEvent.press(screen.getByRole("button", { name: "Close" }));
    expect(props.onClose).toHaveBeenCalledTimes(1);

    expect(mockSheet.isPresented).toBe(true);
    act(() => mockSheet.onDismiss());
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });

  it("keeps the inspiration drawn while the sheet slides away", () => {
    const { rerender } = renderSheet();

    rerender(sheet({ inspiration: null }).element);

    expect(mockSheet.isPresented).toBe(false);
    expect(screen.getByRole("header", { name: "Call Follow-Ups" })).toBeTruthy();
  });

  it("shows the inspiration chosen next", () => {
    const { rerender } = renderSheet();

    rerender(sheet({ inspiration: null }).element);
    rerender(sheet({ inspiration: uncategorized }).element);

    expect(mockSheet.isPresented).toBe(true);
    expect(screen.getByRole("header", { name: "Overheard" })).toBeTruthy();
    expect(screen.queryByRole("header", { name: "Call Follow-Ups" })).toBeNull();
  });
});
