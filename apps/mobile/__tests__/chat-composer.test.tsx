import { cleanup, fireEvent, render, screen } from "@testing-library/react-native";
import { Text } from "react-native";

import { Composer, type ComposerProps } from "../components/chat/Composer";
import { Icon } from "../components/ui/Icon";
import { IconButton } from "../components/ui/IconButton";
import { AddIcon, MicIcon, SendIcon, StopIcon } from "../components/ui/icons";

import { flat } from "./ui-test-utils";

function renderComposer(overrides: Partial<ComposerProps> = {}) {
  const props: ComposerProps = {
    draft: "",
    onChangeDraft: jest.fn(),
    placeholder: "Ask anything",
    canSend: false,
    onSend: jest.fn(),
    keyboardOpen: false,
    ...overrides,
  };
  render(<Composer {...props} />);
  return props;
}

function iconOf(label: string) {
  return screen.getByRole("button", { name: label }).findByType(Icon).props;
}

describe("Composer", () => {
  afterEach(cleanup);

  it("is a bordered card 12pt from the sides and 10pt above the tab bar", () => {
    renderComposer();

    expect(flat(screen.getByTestId("composer"))).toMatchObject({ paddingHorizontal: 12, paddingBottom: 10 });
    expect(flat(screen.getByTestId("composer-card"))).toMatchObject({
      backgroundColor: "#FFFEFC",
      borderWidth: 1,
      borderColor: "#F3F2F2",
      borderRadius: 22,
      boxShadow: "0 4px 16px rgba(0, 0, 0, 0.06)",
    });
  });

  it("sits 8pt above the keyboard while the keyboard is open", () => {
    renderComposer({ keyboardOpen: true });

    expect(flat(screen.getByTestId("composer")).paddingBottom).toBe(8);
  });

  it("pads the input 14pt at the top and sides and leaves 10pt above and below the toolbar", () => {
    renderComposer();

    expect(flat(screen.getByLabelText("Message Matrix"))).toMatchObject({
      paddingTop: 14,
      paddingHorizontal: 14,
      paddingBottom: 10,
      // One 22pt line of text between the two paddings, which also makes the
      // input a 46pt target.
      minHeight: 14 + 22 + 10,
    });
    expect(flat(screen.getByTestId("composer-toolbar"))).toMatchObject({
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 14,
      paddingBottom: 10,
    });
    expect(flat(screen.getByTestId("composer-toolbar-leading"))).toMatchObject({ flexDirection: "row", gap: 8 });
  });

  it("writes the draft in the 16pt body style with a tertiary placeholder and a success caret", () => {
    renderComposer({ draft: "Add a weekly view too" });

    const input = screen.getByLabelText("Message Matrix");
    expect(input.props.value).toBe("Add a weekly view too");
    expect(flat(input)).toMatchObject({ fontFamily: "Geist_400Regular", fontSize: 16, color: "#242323" });
    expect(input.props.placeholderTextColor).toBe("#8A8686");
    expect(input.props.selectionColor).toBe("#288A5B");
    expect(input.props.cursorColor).toBe("#288A5B");
  });

  it.each(["Ask anything", "Reply…", "Signing in…"])("shows the placeholder it is given: %s", (placeholder) => {
    renderComposer({ placeholder });

    expect(screen.getByPlaceholderText(placeholder)).toBeTruthy();
  });

  it("stays a single line whose return key sends", () => {
    const { onSend, onChangeDraft } = renderComposer({ draft: "Ship it", canSend: true });

    const input = screen.getByLabelText("Message Matrix");
    expect(input.props.multiline).toBeFalsy();
    expect(input.props.returnKeyType).toBe("send");
    fireEvent(input, "submitEditing");
    expect(onSend).toHaveBeenCalledTimes(1);
    fireEvent.changeText(input, "Ship it now");
    expect(onChangeDraft).toHaveBeenCalledWith("Ship it now");
  });

  it("cannot be typed in while it is not editable", () => {
    renderComposer({ placeholder: "Signing in…", editable: false });

    expect(screen.getByLabelText("Message Matrix").props.editable).toBe(false);
  });

  it("reports focus and blur", () => {
    const onFocus = jest.fn();
    const onBlur = jest.fn();
    renderComposer({ onFocus, onBlur });

    fireEvent(screen.getByLabelText("Message Matrix"), "focus");
    fireEvent(screen.getByLabelText("Message Matrix"), "blur");

    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(onBlur).toHaveBeenCalledTimes(1);
  });

  it("has a round 44pt attach button on the card fill that does nothing yet", () => {
    renderComposer();

    const attach = screen.getByRole("button", { name: "Attach" });
    expect(flat(attach)).toMatchObject({ width: 44, height: 44, borderRadius: 9999, backgroundColor: "#FAF9F7" });
    expect(iconOf("Attach")).toMatchObject({ icon: AddIcon, size: 18 });
    const attachButton = screen.UNSAFE_getAllByType(IconButton).find((button) => button.props.accessibilityLabel === "Attach");
    expect(attachButton?.props.onPress).toBeUndefined();
  });

  it("puts the model control after the attach button", () => {
    renderComposer({ modelControl: <Text>Matrix AI · Sonnet 5</Text> });

    const leading = screen.getByTestId("composer-toolbar-leading");
    expect(leading.findByProps({ accessibilityLabel: "Attach" })).toBeTruthy();
    expect(screen.getByText("Matrix AI · Sonnet 5")).toBeTruthy();
  });

  it("has a round 44pt send button in the text colour that sends when it can", () => {
    const { onSend } = renderComposer({ draft: "Ship it", canSend: true });

    const send = screen.getByRole("button", { name: "Send message" });
    expect(flat(send)).toMatchObject({ width: 44, height: 44, borderRadius: 9999, backgroundColor: "#242323" });
    expect(iconOf("Send message")).toMatchObject({ icon: SendIcon, size: 18, color: "#FFFEFC" });
    expect(send.props.accessibilityState).toMatchObject({ disabled: false });

    fireEvent.press(send);

    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("looks the same when it cannot send, but is disabled", () => {
    const { onSend } = renderComposer({ canSend: false });

    const send = screen.getByRole("button", { name: "Send message" });
    expect(flat(send)).toMatchObject({ backgroundColor: "#242323" });
    expect(flat(send).opacity).toBeUndefined();
    expect(send.props.accessibilityState).toMatchObject({ disabled: true });

    fireEvent.press(send);

    expect(onSend).not.toHaveBeenCalled();
  });

  it("turns send into a stop button while a turn is running", () => {
    const onStop = jest.fn();
    const { onSend } = renderComposer({ running: true, onStop, canSend: false });

    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
    const stop = screen.getByRole("button", { name: "Stop" });
    expect(flat(stop)).toMatchObject({ width: 44, height: 44, borderRadius: 9999, backgroundColor: "#242323" });
    expect(iconOf("Stop")).toMatchObject({ icon: StopIcon, size: 16, color: "#FFFEFC" });

    fireEvent.press(stop);

    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("keeps the stop button disabled until there is a run to stop", () => {
    renderComposer({ running: true, canSend: false });

    expect(screen.getByRole("button", { name: "Stop" }).props.accessibilityState).toMatchObject({ disabled: true });
  });

  it("has no microphone button", () => {
    renderComposer({ draft: "Ship it", canSend: true });

    expect(screen.UNSAFE_queryAllByType(Icon).some((icon) => icon.props.icon === MicIcon)).toBe(false);
    expect(screen.queryByLabelText(/voice|microphone|dictat/i)).toBeNull();
  });
});
