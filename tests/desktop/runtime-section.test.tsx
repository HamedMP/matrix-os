// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RuntimeSection from "../../desktop/src/renderer/src/features/settings/sections/RuntimeSection";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useRuntimeComputers } from "../../desktop/src/renderer/src/stores/runtime-computers";

const computers = {
  items: [
    {
      handle: "operator",
      runtimeSlot: "primary",
      label: "Main Computer",
      availability: "available",
      kind: "customer",
      gatewayPath: "/vm/operator",
      capabilities: [],
    },
    {
      handle: "operator-review",
      runtimeSlot: "review",
      label: "Additional Computer",
      availability: "available",
      kind: "preview",
      gatewayPath: "/vm/operator-review?runtime=review",
      capabilities: [],
    },
    {
      handle: "operator-preview",
      runtimeSlot: "preview",
      label: "Preview Computer",
      availability: "starting",
      kind: "preview",
      gatewayPath: "/vm/operator-preview?runtime=preview",
      capabilities: [],
    },
  ],
  selectedSlot: "primary",
  hasMore: false,
  limit: 20,
};

describe("desktop runtime settings", () => {
  beforeEach(() => {
    useConnection.setState(useConnection.getInitialState(), true);
    useRuntimeComputers.setState(useRuntimeComputers.getInitialState(), true);
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://app.matrix-os.com",
      runtimeSlot: "primary",
    });
    window.operator = {
      invoke: vi.fn(async (channel: string) => {
        if (channel === "runtime:list-computers") return computers;
        return { ok: true };
      }),
      on: vi.fn(() => () => undefined),
    };
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows the owner's bounded computers instead of a free-text runtime field", async () => {
    render(<RuntimeSection />);

    await waitFor(() => expect(screen.getByText("Main Computer")).not.toBeNull());
    expect(window.operator.invoke).toHaveBeenCalledWith("runtime:list-computers", {});
    expect(screen.getByText("operator-review")).not.toBeNull();
    expect(screen.getByText("Starting")).not.toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("button", { name: "Current computer" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Preview Computer is starting" }).hasAttribute("disabled")).toBe(true);
  });

  it("switches only to an available owner computer", async () => {
    const selectRuntime = vi.fn(async () => undefined);
    useConnection.setState({ selectRuntime });

    render(<RuntimeSection />);
    await waitFor(() => expect(screen.getByText("Additional Computer")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Use Additional Computer" }));

    await waitFor(() => expect(selectRuntime).toHaveBeenCalledWith("review"));
  });

  it("drives the current badge from the server-reported selected slot when the profile is stale", async () => {
    window.operator.invoke = vi.fn(async (channel: string) => {
      if (channel === "runtime:list-computers") return { ...computers, selectedSlot: "review" };
      return { ok: true };
    });
    const selectRuntime = vi.fn(async () => undefined);
    useConnection.setState({ selectRuntime });

    render(<RuntimeSection />);
    await waitFor(() => expect(screen.getByText("Additional Computer")).not.toBeNull());

    expect(screen.getByRole("button", { name: "Current computer" }).hasAttribute("disabled")).toBe(true);
    const staleProfileButton = screen.getByRole("button", { name: "Use Main Computer" });
    expect(staleProfileButton.hasAttribute("disabled")).toBe(false);
    fireEvent.click(staleProfileButton);
    await waitFor(() => expect(selectRuntime).toHaveBeenCalledWith("primary"));
  });

  it("contains malformed responses and switching failures behind safe messages", async () => {
    window.operator.invoke = vi.fn(async (channel: string) => {
      if (channel === "runtime:list-computers") {
        return { items: [{ runtimeSlot: "../secret", token: "raw-secret" }] };
      }
      return { ok: true };
    });
    const selectRuntime = vi.fn(async () => {
      throw new Error("/home/matrix/private token=raw-secret");
    });
    useConnection.setState({ selectRuntime });

    render(<RuntimeSection />);
    await waitFor(() => expect(screen.getByText("Computers are unavailable right now.")).not.toBeNull());
    expect(screen.queryByText(/raw-secret|\/home\/matrix/i)).toBeNull();

    act(() => {
      window.operator.invoke = vi.fn(async (channel: string) => {
        if (channel === "runtime:list-computers") return computers;
        return { ok: true };
      });
      useRuntimeComputers.setState({ status: "idle" });
    });
    fireEvent.click(screen.getByRole("button", { name: "Refresh computers" }));
    await waitFor(() => expect(screen.getByText("Additional Computer")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Use Additional Computer" }));
    await waitFor(() => expect(screen.getByText("Couldn't switch computers. Try again.")).not.toBeNull());
    expect(screen.queryByText(/raw-secret|\/home\/matrix/i)).toBeNull();
  });
});
