import React from "react";
import { render, screen } from "@testing-library/react-native";
import { ChannelBadge } from "../components/ChannelBadge";

describe("ChannelBadge", () => {
  it("renders channel name", () => {
    render(<ChannelBadge name="telegram" status="connected" />);
    expect(screen.getByText("telegram")).toBeTruthy();
  });

  it("shows Connected label for connected status", () => {
    render(<ChannelBadge name="telegram" status="connected" />);
    expect(screen.getByText("Connected")).toBeTruthy();
  });

  it("shows Degraded label for degraded status", () => {
    render(<ChannelBadge name="slack" status="degraded" />);
    expect(screen.getByText("Degraded")).toBeTruthy();
  });

  it("shows Error label for error status", () => {
    render(<ChannelBadge name="discord" status="error" />);
    expect(screen.getByText("Error")).toBeTruthy();
  });

  it("shows Not configured label for not_configured status", () => {
    render(<ChannelBadge name="whatsapp" status="not_configured" />);
    expect(screen.getByText("Not configured")).toBeTruthy();
  });
});
