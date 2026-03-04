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
    expect(getByText("Connecting...")).toBeTruthy();
  });

  it("renders disconnected state", () => {
    const { getByText } = render(
      <ConnectionBanner state="disconnected" queueCount={0} />
    );
    expect(getByText("No connection")).toBeTruthy();
  });

  it("renders error state", () => {
    const { getByText } = render(
      <ConnectionBanner state="error" queueCount={0} />
    );
    expect(getByText("Connection error")).toBeTruthy();
  });

  it("shows queued message count", () => {
    const { getByText } = render(
      <ConnectionBanner state="disconnected" queueCount={3} />
    );
    expect(getByText("No connection (3 queued)")).toBeTruthy();
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
});
