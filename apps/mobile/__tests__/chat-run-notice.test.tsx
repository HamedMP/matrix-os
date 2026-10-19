import { cleanup, fireEvent, render, screen } from "@testing-library/react-native";

import { RunNotice } from "../components/chat/RunNotice";

describe("RunNotice", () => {
  afterEach(cleanup);

  it("says the agent's work failed and why, and offers to run the turn again", () => {
    const onRetry = jest.fn();
    render(<RunNotice text="Connection lost. Reconnect or try again." onRetry={onRetry} />);

    expect(screen.getByText("Agent work failed")).toBeTruthy();
    expect(screen.getByText("Connection lost. Reconnect or try again.")).toBeTruthy();
    fireEvent.press(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("offers nothing when its failure is not one a retry helps", () => {
    render(<RunNotice text="Model unavailable. Choose another model." />);

    expect(screen.getByText("Model unavailable. Choose another model.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows the retry on its way, and keeps it from being pressed again meanwhile", () => {
    const onRetry = jest.fn();
    render(<RunNotice text="Service is busy. Try again shortly." onRetry={onRetry} retrying />);

    const retry = screen.getByRole("button", { name: "Retry" });
    expect(retry.props.accessibilityState).toMatchObject({ busy: true, disabled: true });
    fireEvent.press(retry);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("keeps Retry off while something else runs in the chat", () => {
    render(<RunNotice text="Service is busy. Try again shortly." onRetry={jest.fn()} retryDisabled />);

    expect(screen.getByRole("button", { name: "Retry" }).props.accessibilityState).toMatchObject({ disabled: true });
  });

  it("says, in fixed words, when the retry did not go through", () => {
    render(<RunNotice text="Service is busy. Try again shortly." onRetry={jest.fn()} retryFailed />);

    expect(screen.getByRole("alert", { name: "Could not retry. Try again." })).toBeTruthy();
  });
});
