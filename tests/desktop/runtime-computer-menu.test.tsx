// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RuntimeComputerMenu from "../../desktop/src/renderer/src/features/runtime/RuntimeComputerMenu";
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

describe("sidebar computer menu", () => {
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

  it("shows the active computer and opens an upward list of owner computers", async () => {
    render(<RuntimeComputerMenu collapsed={false} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Change computer, currently Main Computer" })).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Change computer, currently Main Computer" }));

    expect(screen.getByRole("listbox", { name: "Choose computer" })).not.toBeNull();
    expect(screen.getByRole("option", { name: /Main Computer.*Current/i })).not.toBeNull();
    expect(screen.getByRole("option", { name: /Additional Computer.*Available/i })).not.toBeNull();
    expect(screen.getByRole("option", { name: /Preview Computer.*Starting/i }).hasAttribute("disabled")).toBe(true);
  });

  it("switches through trusted runtime selection and closes the menu", async () => {
    const selectRuntime = vi.fn(async () => undefined);
    useConnection.setState({ selectRuntime });
    render(<RuntimeComputerMenu collapsed={false} />);
    await waitFor(() => expect(screen.getByText("Main Computer")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /Change computer/i }));
    fireEvent.click(screen.getByRole("option", { name: /Additional Computer.*Available/i }));

    await waitFor(() => expect(selectRuntime).toHaveBeenCalledWith("review"));
    expect(screen.queryByRole("listbox", { name: "Choose computer" })).toBeNull();
  });

  it("keeps failures safe and offers an inline retry", async () => {
    window.operator.invoke = vi.fn(async () => {
      throw new Error("/home/matrix/private token=raw-secret");
    });
    render(<RuntimeComputerMenu collapsed={false} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Computer list unavailable/i })).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /Computer list unavailable/i }));

    expect(screen.getByText("Computers unavailable")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Retry computers" })).not.toBeNull();
    expect(screen.queryByText(/raw-secret|\/home\/matrix/i)).toBeNull();
  });

  it("clears owner-scoped inventory across sign-out even when the visible identity is reused", async () => {
    const firstInvoke = window.operator.invoke;
    const view = render(<RuntimeComputerMenu collapsed={false} />);
    await waitFor(() => expect(screen.getByText("Main Computer")).not.toBeNull());
    view.unmount();

    act(() => {
      useConnection.setState({ status: "signed-out" });
    });
    window.operator.invoke = vi.fn(async (channel: string) => {
      if (channel === "runtime:list-computers") {
        return {
          ...computers,
          items: [{
            handle: "operator-new",
            runtimeSlot: "primary",
            label: "Main Computer",
            availability: "available",
            kind: "customer",
            gatewayPath: "/vm/operator-new",
            capabilities: [],
          }],
        };
      }
      return { ok: true };
    });
    act(() => {
      useConnection.setState({
        status: "signed-in",
        handle: "operator",
        platformHost: "https://app.matrix-os.com",
        runtimeSlot: "primary",
      });
    });

    render(<RuntimeComputerMenu collapsed={false} />);
    await waitFor(() => expect(screen.getByText("operator-new")).not.toBeNull());
    expect(firstInvoke).toHaveBeenCalledWith("runtime:list-computers", {});
    expect(window.operator.invoke).toHaveBeenCalledWith("runtime:list-computers", {});
  });
});
