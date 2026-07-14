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

  it("refetches inventory when the credential generation changes behind an identical identity", async () => {
    act(() => {
      useConnection.setState({ authGeneration: 1 });
    });
    render(<RuntimeComputerMenu collapsed={false} />);
    await waitFor(() => expect(screen.getByText("Main Computer")).not.toBeNull());

    window.operator.invoke = vi.fn(async (channel: string) => {
      if (channel === "runtime:list-computers") {
        return {
          ...computers,
          items: [{
            handle: "operator-replaced",
            runtimeSlot: "primary",
            label: "Main Computer",
            availability: "available",
            kind: "customer",
            gatewayPath: "/vm/operator-replaced",
            capabilities: [],
          }],
        };
      }
      return { ok: true };
    });
    act(() => {
      useConnection.setState({ authGeneration: 2 });
    });

    await waitFor(() => expect(screen.getByText("operator-replaced")).not.toBeNull());
    expect(window.operator.invoke).toHaveBeenCalledWith("runtime:list-computers", {});
  });

  it("marks the server-reported selected slot as current when the profile slot is stale", async () => {
    window.operator.invoke = vi.fn(async (channel: string) => {
      if (channel === "runtime:list-computers") return { ...computers, selectedSlot: "review" };
      return { ok: true };
    });
    const selectRuntime = vi.fn(async () => undefined);
    useConnection.setState({ selectRuntime });

    render(<RuntimeComputerMenu collapsed={false} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Change computer, currently Additional Computer" })).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /Change computer/i }));

    expect(screen.getByRole("option", { name: /Additional Computer.*Current/i }).hasAttribute("disabled")).toBe(true);
    const staleProfileOption = screen.getByRole("option", { name: /Main Computer.*Available/i });
    expect(staleProfileOption.hasAttribute("disabled")).toBe(false);
    fireEvent.click(staleProfileOption);
    await waitFor(() => expect(selectRuntime).toHaveBeenCalledWith("primary"));
  });

  it("caps long computer lists behind a scrollable region", async () => {
    const manyComputers = {
      ...computers,
      items: Array.from({ length: 20 }, (_, index) => ({
        handle: `operator-${index}`,
        runtimeSlot: index === 0 ? "primary" : `slot-${index}`,
        label: index === 0 ? "Main Computer" : "Additional Computer",
        availability: "available",
        kind: index === 0 ? "customer" : "preview",
        gatewayPath: index === 0 ? "/vm/operator-0" : `/vm/operator-${index}?runtime=slot-${index}`,
        capabilities: [],
      })),
    };
    window.operator.invoke = vi.fn(async (channel: string) => (
      channel === "runtime:list-computers" ? manyComputers : { ok: true }
    ));

    render(<RuntimeComputerMenu collapsed={false} />);
    await waitFor(() => expect(screen.getByText("operator-0")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /Change computer/i }));

    const listbox = screen.getByRole("listbox", { name: "Choose computer" });
    const scrollRegion = listbox.querySelector(".overflow-y-auto");
    expect(scrollRegion).not.toBeNull();
    expect(scrollRegion?.className).toMatch(/max-h-/);
    expect(screen.getAllByRole("option")).toHaveLength(20);
  });

  it("keeps the collapsed rail menu wide enough to read computer labels", async () => {
    render(<RuntimeComputerMenu collapsed />);
    await waitFor(() => expect(window.operator.invoke).toHaveBeenCalledWith("runtime:list-computers", {}));
    fireEvent.click(screen.getByRole("button", { name: /Change computer/i }));

    const listbox = screen.getByRole("listbox", { name: "Choose computer" });
    expect(listbox.className).toMatch(/w-64/);
    expect(listbox.className).not.toMatch(/right-2/);
  });

  it("clears owner-scoped inventory when a signed-in session is replaced in place", async () => {
    useConnection.setState({ api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() } as never });
    const view = render(<RuntimeComputerMenu collapsed={false} />);
    await waitFor(() => expect(screen.getByText("operator")).not.toBeNull());
    view.unmount();

    window.operator.invoke = vi.fn(async (channel: string) => {
      if (channel === "runtime:list-computers") {
        return {
          ...computers,
          items: [{
            handle: "operator-new-session",
            runtimeSlot: "primary",
            label: "Main Computer",
            availability: "available",
            kind: "customer",
            gatewayPath: "/vm/operator-new-session",
            capabilities: [],
          }],
        };
      }
      return { ok: true };
    });
    act(() => {
      useConnection.setState({ api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() } as never });
    });

    render(<RuntimeComputerMenu collapsed={false} />);
    await waitFor(() => expect(screen.getByText("operator-new-session")).not.toBeNull());
    expect(window.operator.invoke).toHaveBeenCalledWith("runtime:list-computers", {});
  });
});
