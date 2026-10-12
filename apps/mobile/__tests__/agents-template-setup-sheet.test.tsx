import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react-native";
import { ActivityIndicator } from "react-native";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";

import { TemplateSetupSheet, type TemplateSetupSheetProps } from "../components/agents/TemplateSetupSheet";
import type { AgentTemplate } from "../components/agents/agent-templates";
import { AgentMascot } from "../components/ui/AgentMascot";
import { Icon } from "../components/ui/Icon";
import { CloseIcon } from "../components/ui/icons";

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

const research: AgentTemplate = {
  recipeId: "account-research",
  version: "v2",
  name: "Account research",
  description: "Briefs you before every sales call",
  category: "sales",
};
const inbox: AgentTemplate = {
  recipeId: "inbox-triage",
  version: "v1",
  name: "Inbox triage",
  description: "Sorts your inbox and drafts replies",
};

function sheet(overrides: Partial<TemplateSetupSheetProps> = {}) {
  const props: TemplateSetupSheetProps = {
    template: research,
    creating: false,
    failed: false,
    onCreate: jest.fn(),
    onSetUpInChat: jest.fn(),
    onClose: jest.fn(),
    ...overrides,
  };
  const element = (
    <SafeAreaInsetsContext.Provider value={{ top: 62, right: 0, bottom: 34, left: 0 }}>
      <TemplateSetupSheet {...props} />
    </SafeAreaInsetsContext.Provider>
  );
  return { props, element };
}

function renderSheet(overrides: Partial<TemplateSetupSheetProps> = {}) {
  const { props, element } = sheet(overrides);
  return { props, ...render(element) };
}

describe("template setup sheet", () => {
  afterEach(cleanup);

  it("stays closed until a template is chosen", () => {
    renderSheet({ template: null });

    expect(mockSheet.isPresented).toBe(false);
    expect(screen.queryByRole("button", { name: "Create agent" })).toBeNull();
  });

  it("pads the sheet 20pt at the sides and 10pt past the home indicator, with 14pt between blocks", () => {
    renderSheet();

    const body = flat(screen.getByTestId("template-setup"));
    expect(body).toMatchObject({ paddingHorizontal: 20, paddingBottom: 34 + 10, gap: 14 });
    expect(body.paddingTop).toBeUndefined();
  });

  it("starts with the grabber, 10pt from the top", () => {
    renderSheet();

    const first = screen.getByTestId("template-setup").children[0];
    expect(typeof first === "string" ? first : first.props.testID).toBe("template-setup-grabber");
    expect(flat(screen.getByTestId("template-setup-grabber"))).toMatchObject({
      width: 36,
      height: 5,
      marginTop: 10,
      backgroundColor: "#D6D3CF",
    });
  });

  it("heads the sheet with the 48pt mascot, the template's name over its description, and a close button", () => {
    renderSheet();

    const head = screen.getByTestId("template-setup-head");
    expect(flat(head)).toMatchObject({ flexDirection: "row", alignItems: "center", gap: 12 });
    expect(within(head).UNSAFE_getByType(AgentMascot).props).toMatchObject({
      id: "account-research",
      name: "Account research",
      category: "sales",
      size: 48,
    });
    expect(flat(within(head).getByRole("header", { name: "Account research" }))).toMatchObject({
      fontFamily: "Geist_600SemiBold",
      fontSize: 18,
      lineHeight: 25,
      color: "#242323",
    });
    expect(flat(within(head).getByText("Briefs you before every sales call"))).toMatchObject({
      fontFamily: "Geist_400Regular",
      fontSize: 13,
      lineHeight: 18,
      color: "#635F5F",
      marginTop: 2,
    });
  });

  it("closes from a 44pt close button with a 20pt icon in the subtle colour", () => {
    const { props } = renderSheet();

    const close = screen.getByRole("button", { name: "Close" });
    expect(flat(close)).toMatchObject({ width: 44, height: 44 });
    expect(within(close).UNSAFE_getByType(Icon).props).toMatchObject({ icon: CloseIcon, size: 20, color: "#635F5F" });
    fireEvent.press(close);

    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("closes when the sheet is dragged away", () => {
    const { props } = renderSheet();

    expect(mockSheet.isPresented).toBe(true);
    act(() => mockSheet.onDismiss());

    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("labels the name field and fills it with the template's name", () => {
    renderSheet();

    const label = screen.getByRole("header", { name: "Name" });
    expect(flat(label)).toMatchObject({ fontSize: 12, lineHeight: 17, textTransform: "uppercase", color: "#8A8686" });
    const field = screen.getByLabelText("Name");
    expect(field.props.value).toBe("Account research");
    expect(field.props.maxLength).toBe(80);
  });

  it("creates the agent under the name in the field, without the space around it", () => {
    const { props } = renderSheet();

    fireEvent.changeText(screen.getByLabelText("Name"), "  Key accounts ");
    fireEvent.press(screen.getByRole("button", { name: "Create agent" }));

    expect(props.onCreate).toHaveBeenCalledWith("Key accounts");
  });

  it("draws Create agent as a filled, large, full-width button", () => {
    renderSheet();

    expect(flat(screen.getByRole("button", { name: "Create agent" }))).toMatchObject({
      height: 48,
      alignSelf: "stretch",
      backgroundColor: "#171717",
    });
  });

  it("draws Set up in chat instead as a text-only, large, full-width button 4pt below", () => {
    const { props } = renderSheet();

    const button = screen.getByRole("button", { name: "Set up in chat instead" });
    expect(flat(button)).toMatchObject({ height: 48, alignSelf: "stretch" });
    expect(flat(button).backgroundColor).toBeUndefined();
    expect(flat(screen.getByTestId("template-setup-actions")).gap).toBe(4);

    fireEvent.press(button);
    expect(props.onSetUpInChat).toHaveBeenCalledTimes(1);
  });

  it.each(["", "   "])("cannot create while the name is blank (%p)", (name) => {
    const { props } = renderSheet();

    fireEvent.changeText(screen.getByLabelText("Name"), name);
    const create = screen.getByRole("button", { name: "Create agent" });
    expect(create.props.accessibilityState).toMatchObject({ disabled: true });
    fireEvent.press(create);

    expect(props.onCreate).not.toHaveBeenCalled();
  });

  it("shows the request in flight on the button and holds the other controls", () => {
    const { props } = renderSheet({ creating: true });

    const create = screen.getByRole("button", { name: "Create agent" });
    expect(create.props.accessibilityState).toMatchObject({ busy: true, disabled: true });
    expect(within(create).UNSAFE_getByType(ActivityIndicator)).toBeTruthy();
    fireEvent.press(create);
    fireEvent.press(screen.getByRole("button", { name: "Set up in chat instead" }));

    expect(props.onCreate).not.toHaveBeenCalled();
    expect(props.onSetUpInChat).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Name").props.editable).toBe(false);
  });

  it("says in the danger colour, under the field, that the agent could not be created", () => {
    renderSheet({ failed: true });

    const line = screen.getByRole("alert");
    expect(line.props.children).toBe("Agent could not be created. Try again.");
    expect(flat(line)).toMatchObject({ fontSize: 14, lineHeight: 20, color: "#BA5236" });
    const block = screen.getByTestId("template-setup-field");
    expect(flat(block).gap).toBe(8);
    expect(within(block).getByLabelText("Name")).toBeTruthy();
    expect(within(block).getByRole("alert")).toBeTruthy();
    // The typed name is kept for the retry.
    expect(screen.getByLabelText("Name").props.value).toBe("Account research");
  });

  it("shows no failure line otherwise", () => {
    renderSheet();

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps drawing the template while the sheet slides away", () => {
    const { rerender } = renderSheet();

    rerender(sheet({ template: null }).element);

    expect(mockSheet.isPresented).toBe(false);
    expect(screen.getByRole("header", { name: "Account research" })).toBeTruthy();
    expect(screen.getByLabelText("Name").props.value).toBe("Account research");
  });

  it("starts from the template's name again each time it is opened", () => {
    const { rerender } = renderSheet();
    fireEvent.changeText(screen.getByLabelText("Name"), "Typed and abandoned");

    rerender(sheet({ template: null }).element);
    rerender(sheet({ template: research }).element);
    expect(screen.getByLabelText("Name").props.value).toBe("Account research");

    rerender(sheet({ template: inbox }).element);
    expect(screen.getByLabelText("Name").props.value).toBe("Inbox triage");
    expect(screen.getByRole("header", { name: "Inbox triage" })).toBeTruthy();
  });

  it("draws none of the controls the server has nothing behind", () => {
    renderSheet();

    for (const label of ["Apps", "Runs"]) {
      expect(screen.queryByRole("header", { name: label })).toBeNull();
    }
    for (const text of ["Web search", "Google Calendar", "Google Drive", "Connected", "When I ask", "Before each meeting", "Every morning"]) {
      expect(screen.queryByText(text)).toBeNull();
    }
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
  });
});
