import React from "react";
import { render } from "@testing-library/react-native";
import { ConnectionBanner } from "../components/ConnectionBanner";

describe("ConnectionBanner", () => {
  it("renders nothing when connected", () => {
    const { toJSON } = render(
      <ConnectionBanner state="connected" queueCount={0} />
    );
    expect(toJSON()).toBeNull();
  });

  it("renders connecting state", () => {
    const { getByText } = render(
      <ConnectionBanner state="connecting" queueCount={0} />
    );
    expect(getByText("Connecting to Matrix OS")).toBeTruthy();
  });

  it("renders disconnected state", () => {
    const { getByText } = render(
      <ConnectionBanner state="disconnected" queueCount={0} />
    );
    expect(getByText("Chat socket offline")).toBeTruthy();
  });

  it("renders error state", () => {
    const { getByText } = render(
      <ConnectionBanner state="error" queueCount={0} />
    );
    expect(getByText("Chat reconnecting")).toBeTruthy();
  });

  it("shows queued message count", () => {
    const { getByText } = render(
      <ConnectionBanner state="disconnected" queueCount={3} />
    );
    expect(getByText("Chat socket offline (3 queued)")).toBeTruthy();
  });

  it("shows retry button on error", () => {
    const onRetry = jest.fn();
    const { getByText } = render(
      <ConnectionBanner state="error" queueCount={0} onRetry={onRetry} />
    );
    expect(getByText("Retry")).toBeTruthy();
  });

  it("does not show retry button when not error", () => {
    const { queryByText } = render(
      <ConnectionBanner state="disconnected" queueCount={0} onRetry={() => {}} />
    );
    expect(queryByText("Retry")).toBeNull();
  });

  it("supports surface-specific recovery labels", () => {
    const { getByText } = render(
      <ConnectionBanner
        state="error"
        queueCount={0}
        labels={{
          error: "Agent workspace reconnecting",
        }}
      />
    );

    expect(getByText("Agent workspace reconnecting")).toBeTruthy();
  });
});
