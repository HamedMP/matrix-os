import React from "react";
import { render, screen, fireEvent } from "@testing-library/react-native";
import { GatewayCard } from "../components/GatewayCard";
import type { GatewayConnection } from "../lib/storage";

function gw(overrides: Partial<GatewayConnection> = {}): GatewayConnection {
  return {
    id: "gw-1",
    url: "http://localhost:4000",
    name: "Local Gateway",
    addedAt: Date.now(),
    ...overrides,
  };
}

describe("GatewayCard", () => {
  it("renders gateway name", () => {
    render(
      <GatewayCard gateway={gw()} onSelect={jest.fn()} onRemove={jest.fn()} />,
    );
    expect(screen.getByText("Local Gateway")).toBeTruthy();
  });

  it("renders gateway URL", () => {
    render(
      <GatewayCard gateway={gw()} onSelect={jest.fn()} onRemove={jest.fn()} />,
    );
    expect(screen.getByText("http://localhost:4000")).toBeTruthy();
  });

  it("shows Authenticated badge when token present", () => {
    render(
      <GatewayCard
        gateway={gw({ token: "secret123" })}
        onSelect={jest.fn()}
        onRemove={jest.fn()}
      />,
    );
    expect(screen.getByText("Authenticated")).toBeTruthy();
  });

  it("hides badge when no token", () => {
    render(
      <GatewayCard gateway={gw()} onSelect={jest.fn()} onRemove={jest.fn()} />,
    );
    expect(screen.queryByText("Authenticated")).toBeNull();
  });

  it("calls onSelect when pressed", () => {
    const onSelect = jest.fn();
    render(
      <GatewayCard gateway={gw()} onSelect={onSelect} onRemove={jest.fn()} />,
    );
    fireEvent.press(screen.getByText("Local Gateway"));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
