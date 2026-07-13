import React from "react";
import { render, screen, fireEvent } from "@testing-library/react-native";
import { InputBar } from "../components/InputBar";

describe("InputBar", () => {
  const defaultProps = {
    onSend: jest.fn(),
    busy: false,
    connected: true,
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders input field", () => {
    render(<InputBar {...defaultProps} />);
    expect(screen.getByPlaceholderText("Message your Matrix…")).toBeTruthy();
  });

  it("shows 'Matrix is thinking…' placeholder when busy", () => {
    render(<InputBar {...defaultProps} busy={true} />);
    expect(screen.getByPlaceholderText("Matrix is thinking…")).toBeTruthy();
  });

  it("shows 'Connecting…' placeholder when not connected", () => {
    render(<InputBar {...defaultProps} connected={false} />);
    expect(screen.getByPlaceholderText("Connecting…")).toBeTruthy();
  });

  it("calls onSend with trimmed text when send pressed", () => {
    const onSend = jest.fn();
    render(<InputBar {...defaultProps} onSend={onSend} />);
    const input = screen.getByPlaceholderText("Message your Matrix…");
    fireEvent.changeText(input, "  hello world  ");
    fireEvent.press(screen.getByTestId("icon-arrow-up"));
    expect(onSend).toHaveBeenCalledWith("hello world");
  });

  it("does not call onSend when text is empty", () => {
    const onSend = jest.fn();
    render(<InputBar {...defaultProps} onSend={onSend} />);
    fireEvent.press(screen.getByTestId("icon-arrow-up"));
    expect(onSend).not.toHaveBeenCalled();
  });

  it("does not call onSend when disconnected", () => {
    const onSend = jest.fn();
    render(<InputBar {...defaultProps} onSend={onSend} connected={false} />);
    const input = screen.getByPlaceholderText("Connecting…");
    fireEvent.changeText(input, "hello");
    fireEvent.press(screen.getByTestId("icon-arrow-up"));
    expect(onSend).not.toHaveBeenCalled();
  });

  it("clears input after sending", () => {
    render(<InputBar {...defaultProps} />);
    const input = screen.getByPlaceholderText("Message your Matrix…");
    fireEvent.changeText(input, "hello");
    fireEvent.press(screen.getByTestId("icon-arrow-up"));
    expect(input.props.value).toBe("");
  });

  it("triggers haptic on send", () => {
    const Haptics = require("expo-haptics");
    render(<InputBar {...defaultProps} />);
    const input = screen.getByPlaceholderText("Message your Matrix…");
    fireEvent.changeText(input, "hello");
    fireEvent.press(screen.getByTestId("icon-arrow-up"));
    expect(Haptics.impactAsync).toHaveBeenCalledWith("light");
  });
});
