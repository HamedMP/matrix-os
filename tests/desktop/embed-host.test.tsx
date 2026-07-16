// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EmbedHost from "../../desktop/src/renderer/src/features/embeds/EmbedHost";
import { invoke } from "../../desktop/src/renderer/src/lib/operator";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";

vi.mock("../../desktop/src/renderer/src/lib/operator", () => ({
  invoke: vi.fn(),
  onEvent: vi.fn(() => () => undefined),
}));

describe("EmbedHost", () => {
  let openResolve: ((value: { embedId: string; state: "loading" | "auth-required" }) => void) | null = null;
  let rect = { left: 10, top: 20, width: 300, height: 200 };

  beforeEach(() => {
    useConnection.setState(useConnection.getInitialState(), true);
    useConnection.setState({ runtimeSlot: "primary" });
    openResolve = null;
    rect = { left: 10, top: 20, width: 300, height: 200 };
    vi.mocked(invoke).mockImplementation((channel: string) => {
      if (channel === "embed:open") {
        return new Promise((resolve) => {
          openResolve = resolve as typeof openResolve;
        }) as ReturnType<typeof invoke>;
      }
      return Promise.resolve({ ok: true }) as ReturnType<typeof invoke>;
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () =>
        ({
          x: rect.left,
          y: rect.top,
          left: rect.left,
          top: rect.top,
          right: rect.left + rect.width,
          bottom: rect.top + rect.height,
          width: rect.width,
          height: rect.height,
          toJSON: () => ({}),
        }) as DOMRect,
    );
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserver {
        observe() {}
        disconnect() {}
      },
    );
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("reports fresh bounds when the embed opens after a pending layout change", async () => {
    render(<EmbedHost kind="hosted-shell" />);

    rect = { left: 40, top: 50, width: 640, height: 480 };
    window.dispatchEvent(new Event("resize"));

    await act(async () => {
      openResolve?.({ embedId: "embed-1", state: "loading" });
    });

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("embed:set-bounds", {
        embedId: "embed-1",
        bounds: { x: 40, y: 50, width: 640, height: 480 },
      });
    });
  });

  it("restores the auth retry prompt when retryAuth returns ok false", async () => {
    vi.mocked(invoke).mockImplementation((channel: string) => {
      if (channel === "embed:open") {
        return Promise.resolve({ embedId: "embed-1", state: "auth-required" }) as ReturnType<typeof invoke>;
      }
      if (channel === "embed:retry-auth") {
        return Promise.resolve({ ok: false }) as ReturnType<typeof invoke>;
      }
      return Promise.resolve({ ok: true }) as ReturnType<typeof invoke>;
    });

    render(<EmbedHost kind="hosted-shell" />);

    fireEvent.click(await screen.findByRole("button", { name: "Retry sign-in" }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("embed:retry-auth", { embedId: "embed-1" });
      expect(screen.getByRole("button", { name: "Retry sign-in" })).toBeTruthy();
    });
  });

  it("refreshes bounds after a successful auth retry", async () => {
    vi.mocked(invoke).mockImplementation((channel: string) => {
      if (channel === "embed:open") {
        return Promise.resolve({ embedId: "embed-1", state: "auth-required" }) as ReturnType<typeof invoke>;
      }
      if (channel === "embed:retry-auth") {
        return Promise.resolve({ ok: true }) as ReturnType<typeof invoke>;
      }
      return Promise.resolve({ ok: true }) as ReturnType<typeof invoke>;
    });

    render(<EmbedHost kind="hosted-shell" />);

    await screen.findByRole("button", { name: "Retry sign-in" });
    vi.mocked(invoke).mockClear();
    rect = { left: 90, top: 100, width: 700, height: 500 };
    fireEvent.click(screen.getByRole("button", { name: "Retry sign-in" }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("embed:retry-auth", { embedId: "embed-1" });
      expect(invoke).toHaveBeenCalledWith("embed:set-bounds", {
        embedId: "embed-1",
        bounds: { x: 90, y: 100, width: 700, height: 500 },
      });
    });
  });

  it("reopens the hosted surface after the trusted runtime changes", async () => {
    let nextEmbedId = 0;
    vi.mocked(invoke).mockImplementation((channel: string) => {
      if (channel === "embed:open") {
        nextEmbedId += 1;
        return Promise.resolve({ embedId: `embed-${nextEmbedId}`, state: "ready" }) as ReturnType<typeof invoke>;
      }
      return Promise.resolve({ ok: true }) as ReturnType<typeof invoke>;
    });

    render(<EmbedHost kind="hosted-shell" />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      "embed:set-active",
      { embedId: "embed-1", active: true },
    ));

    act(() => {
      useConnection.setState({ runtimeSlot: "review" });
    });

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("embed:close", { embedId: "embed-1" });
      expect(invoke).toHaveBeenCalledWith(
        "embed:set-active",
        { embedId: "embed-2", active: true },
      );
    });
  });
});
