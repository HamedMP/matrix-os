import { cleanup, fireEvent, render, screen } from "@testing-library/react-native";
import { Pressable } from "react-native";

import { ModelTrigger } from "../components/chat/ModelTrigger";
import { Icon } from "../components/ui/Icon";
import { DisclosureDownIcon, LoadingIcon } from "../components/ui/icons";
import { ProviderLogo } from "../components/ui/ProviderLogo";

import { flat, pressedStyle } from "./ui-test-utils";

function icons() {
  return screen.UNSAFE_queryAllByType(Icon).map((icon) => icon.props);
}

describe("ModelTrigger", () => {
  afterEach(cleanup);

  it("is a 44pt control holding the engine's logo, the label and a 14pt chevron", () => {
    render(<ModelTrigger provider="matrix" label="Matrix AI · Sonnet 5" onPress={jest.fn()} />);

    const trigger = screen.getByRole("button", { name: "Model" });
    expect(trigger.props.accessibilityValue).toEqual({ text: "Matrix AI · Sonnet 5" });
    expect(flat(trigger)).toMatchObject({
      height: 44,
      borderRadius: 10,
      paddingHorizontal: 10,
      gap: 6,
      flexDirection: "row",
      alignItems: "center",
    });
    expect(screen.UNSAFE_getByType(ProviderLogo).props).toMatchObject({ provider: "matrix", size: 14 });
    expect(icons()).toEqual([expect.objectContaining({ icon: DisclosureDownIcon, size: 14, color: "#635F5F" })]);
  });

  it("writes the label on one line in the 14pt regular style", () => {
    render(<ModelTrigger provider="matrix" label="Matrix AI · Sonnet 5" onPress={jest.fn()} />);

    const label = screen.getByText("Matrix AI · Sonnet 5");
    expect(label.props.numberOfLines).toBe(1);
    expect(flat(label)).toMatchObject({
      flexShrink: 1,
      fontFamily: "Geist_400Regular",
      fontSize: 14,
      lineHeight: 20,
      color: "#242323",
    });
  });

  it("opens the model choice when pressed, and dims while held", () => {
    const onPress = jest.fn();
    render(<ModelTrigger provider="matrix" label="Matrix AI · Sonnet 5" onPress={onPress} />);

    fireEvent.press(screen.getByRole("button", { name: "Model" }));

    expect(onPress).toHaveBeenCalledTimes(1);
    expect(pressedStyle({ accessibilityLabel: "Model" }).opacity).toBe(0.65);
  });

  it("leaves the logo out when no engine is chosen", () => {
    render(<ModelTrigger label="Choose a model" onPress={jest.fn()} />);

    expect(screen.UNSAFE_queryByType(ProviderLogo)).toBeNull();
    expect(screen.getByText("Choose a model")).toBeTruthy();
  });

  it("shows a spinner in the chevron's place while the models are being checked", () => {
    render(<ModelTrigger provider="matrix" label="Matrix AI · Sonnet 5" loading onPress={jest.fn()} />);

    expect(screen.getByLabelText("Checking model availability")).toBeTruthy();
    expect(icons()).toEqual([expect.objectContaining({ icon: LoadingIcon, size: 14, color: "#635F5F" })]);
  });

  it("does nothing and says so when it is disabled", () => {
    const onPress = jest.fn();
    render(<ModelTrigger provider="matrix" label="Matrix AI · Sonnet 5" disabled onPress={onPress} />);

    const trigger = screen.getByRole("button", { name: "Model" });
    fireEvent.press(trigger);

    expect(onPress).not.toHaveBeenCalled();
    expect(trigger.props.accessibilityState).toMatchObject({ disabled: true });
    expect(flat(trigger).opacity).toBe(0.5);
  });

  it("reports that the models are being checked, and can still be pressed meanwhile", () => {
    const onPress = jest.fn();
    render(<ModelTrigger provider="matrix" label="Matrix AI · Sonnet 5" loading onPress={onPress} />);

    const trigger = screen.getByRole("button", { name: "Model" });
    expect(trigger.props.accessibilityState).toMatchObject({ busy: true, disabled: false });
    fireEvent.press(trigger);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("is a plain label with no chevron when the model is fixed", () => {
    render(<ModelTrigger label="Bot model" fixed />);

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.UNSAFE_queryByType(Pressable)).toBeNull();
    expect(screen.getByText("Bot model")).toBeTruthy();
    expect(icons()).toEqual([]);
  });

  it("caps the label's width when it is given one", () => {
    render(<ModelTrigger provider="codex" label="Codex · GPT Test" maxLabelWidth={120} onPress={jest.fn()} />);

    expect(flat(screen.getByText("Codex · GPT Test")).maxWidth).toBe(120);
  });
});
