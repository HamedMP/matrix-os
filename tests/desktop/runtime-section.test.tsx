// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RuntimeSection from "../../desktop/src/renderer/src/features/settings/sections/RuntimeSection";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";

function makeApi(response: unknown) {
  return {
    baseUrl: "https://app.matrix-os.com",
    get: vi.fn(async () => response),
    getText: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    putText: vi.fn(),
  };
}

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
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://app.matrix-os.com",
      runtimeSlot: "primary",
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows the owner's bounded computers instead of a free-text runtime field", async () => {
    const api = makeApi(computers);
    useConnection.setState({ api: api as never });

    render(<RuntimeSection />);

    await waitFor(() => expect(screen.getByText("Main Computer")).not.toBeNull());
    expect(api.get).toHaveBeenCalledWith("/api/auth/computers");
    expect(screen.getByText("operator-review")).not.toBeNull();
    expect(screen.getByText("Starting")).not.toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("button", { name: "Current computer" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Preview Computer is starting" }).hasAttribute("disabled")).toBe(true);
  });

  it("switches only to an available owner computer", async () => {
    const api = makeApi(computers);
    const selectRuntime = vi.fn(async () => undefined);
    useConnection.setState({ api: api as never, selectRuntime });

    render(<RuntimeSection />);
    await waitFor(() => expect(screen.getByText("Additional Computer")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Use Additional Computer" }));

    await waitFor(() => expect(selectRuntime).toHaveBeenCalledWith("review"));
  });

  it("contains malformed responses and switching failures behind safe messages", async () => {
    const api = makeApi({ items: [{ runtimeSlot: "../secret", token: "raw-secret" }] });
    const selectRuntime = vi.fn(async () => {
      throw new Error("/home/matrix/private token=raw-secret");
    });
    useConnection.setState({ api: api as never, selectRuntime });

    const { rerender } = render(<RuntimeSection />);
    await waitFor(() => expect(screen.getByText("Computers are unavailable right now.")).not.toBeNull());
    expect(screen.queryByText(/raw-secret|\/home\/matrix/i)).toBeNull();

    act(() => {
      useConnection.setState({ api: makeApi(computers) as never });
    });
    rerender(<RuntimeSection />);
    await waitFor(() => expect(screen.getByText("Additional Computer")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Use Additional Computer" }));
    await waitFor(() => expect(screen.getByText("Couldn't switch computers. Try again.")).not.toBeNull());
    expect(screen.queryByText(/raw-secret|\/home\/matrix/i)).toBeNull();
  });
});
