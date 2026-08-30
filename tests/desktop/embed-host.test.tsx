// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EmbedHost from "../../desktop/src/renderer/src/features/embeds/EmbedHost";
import { invoke, onEvent } from "../../desktop/src/renderer/src/lib/operator";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";

vi.mock("../../desktop/src/renderer/src/lib/operator", () => ({
  invoke: vi.fn(),
  onEvent: vi.fn(() => () => undefined),
}));

describe("EmbedHost", () => {
  let openResolve: ((value: { embedId: string; state: "loading" | "auth-required" }) => void) | null = null;
  let rect = { left: 10, top: 20, width: 300, height: 200 };

  beforeEach(() => {
    vi.mocked(invoke).mockClear();
    vi.mocked(onEvent).mockReset();
    vi.mocked(onEvent).mockReturnValue(() => undefined);
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

  it("reports position-only changes when its desktop layout revision changes", async () => {
    const view = render(<EmbedHost kind="hosted-shell" layoutRevision="window:10:20:300:200" />);
    await act(async () => {
      openResolve?.({ embedId: "embed-1", state: "loading" });
    });
    vi.mocked(invoke).mockClear();
    rect = { left: 90, top: 120, width: 300, height: 200 };

    view.rerender(<EmbedHost kind="hosted-shell" layoutRevision="window:90:120:300:200" />);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("embed:set-bounds", {
        embedId: "embed-1",
        bounds: { x: 90, y: 120, width: 300, height: 200 },
      });
    });
  });

  it("resynchronizes native bounds and page scale when the Canvas transform changes", async () => {
    const view = render(<EmbedHost kind="app" slug="notes" layoutRevision="canvas:0:0:1" visualScale={1} />);
    await act(async () => {
      openResolve?.({ embedId: "embed-1", state: "loading" });
    });
    vi.mocked(invoke).mockClear();
    rect = { left: -180, top: 75, width: 450, height: 300 };

    view.rerender(<EmbedHost kind="app" slug="notes" layoutRevision="canvas:-200:50:0.5" visualScale={0.5} />);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("embed:set-scale", { embedId: "embed-1", factor: 0.5 });
      expect(invoke).toHaveBeenCalledWith("embed:set-bounds", {
        embedId: "embed-1",
        bounds: { x: -180, y: 75, width: 450, height: 300 },
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

  it("wires runtime Browser URLs through the typed embed request", async () => {
    vi.mocked(invoke).mockImplementation((channel: string) => {
      if (channel === "embed:open") {
        return Promise.resolve({ embedId: "browser-1", state: "loading" }) as ReturnType<typeof invoke>;
      }
      return Promise.resolve({ ok: true }) as ReturnType<typeof invoke>;
    });

    render(<EmbedHost kind="browser" url="http://127.0.0.1:3000/docs" />);

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("embed:open", {
      kind: "browser",
      url: "http://127.0.0.1:3000/docs",
      bounds: { x: 10, y: 20, width: 300, height: 200 },
      active: true,
    }));
  });

  it("opens VS Code through the fixed trusted code-editor request", async () => {
    vi.mocked(invoke).mockImplementation((channel: string) => {
      if (channel === "embed:open") {
        return Promise.resolve({ embedId: "code-1", state: "loading" }) as ReturnType<typeof invoke>;
      }
      return Promise.resolve({ ok: true }) as ReturnType<typeof invoke>;
    });

    render(<EmbedHost kind="code-editor" />);

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("embed:open", {
      kind: "code-editor",
      bounds: { x: 10, y: 20, width: 300, height: 200 },
      active: true,
    }));
  });

  it("reopens the same runtime Browser URL after an unexpected tunnel failure", async () => {
    let nextEmbedId = 0;
    let emitState: ((payload: { embedId: string; state: "failed" }) => void) | null = null;
    vi.mocked(onEvent).mockImplementation((_channel, callback) => {
      emitState = callback as typeof emitState;
      return () => undefined;
    });
    vi.mocked(invoke).mockImplementation((channel: string) => {
      if (channel === "embed:open") {
        nextEmbedId += 1;
        return Promise.resolve({ embedId: `browser-${nextEmbedId}`, state: "ready" }) as ReturnType<typeof invoke>;
      }
      return Promise.resolve({ ok: true }) as ReturnType<typeof invoke>;
    });

    render(<EmbedHost kind="browser" url="http://127.0.0.1:3000/docs" />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      "embed:set-active",
      { embedId: "browser-1", active: true },
    ));

    act(() => emitState?.({ embedId: "browser-1", state: "failed" }));
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("embed:close", { embedId: "browser-1" });
      expect(vi.mocked(invoke).mock.calls.filter(([channel]) => channel === "embed:open")).toHaveLength(2);
      expect(invoke).toHaveBeenCalledWith("embed:open", {
        kind: "browser",
        url: "http://127.0.0.1:3000/docs",
        bounds: { x: 10, y: 20, width: 300, height: 200 },
        active: true,
      });
      expect(invoke).toHaveBeenCalledWith(
        "embed:set-active",
        { embedId: "browser-2", active: true },
      );
    });
  });

  it("reloads the retained native embed when the host receives a refresh request", async () => {
    const view = render(<EmbedHost kind="hosted-shell" refreshRequest={0} />);
    await act(async () => {
      openResolve?.({ embedId: "embed-1", state: "loading" });
    });
    vi.mocked(invoke).mockClear();

    view.rerender(<EmbedHost kind="hosted-shell" refreshRequest={1} />);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("embed:reload", { embedId: "embed-1" });
    });
  });

  it("keeps a refresh request pending until the retained embed finishes opening", async () => {
    const view = render(<EmbedHost kind="hosted-shell" refreshRequest={0} />);
    view.rerender(<EmbedHost kind="hosted-shell" refreshRequest={1} />);
    expect(invoke).not.toHaveBeenCalledWith("embed:reload", expect.anything());

    await act(async () => {
      openResolve?.({ embedId: "embed-1", state: "loading" });
    });

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("embed:reload", { embedId: "embed-1" });
    });
  });

  it("keeps a refresh request pending while the retained embed is inactive", async () => {
    const view = render(<EmbedHost kind="hosted-shell" active={false} refreshRequest={0} />);
    await act(async () => {
      openResolve?.({ embedId: "embed-1", state: "loading" });
    });
    vi.mocked(invoke).mockClear();

    view.rerender(<EmbedHost kind="hosted-shell" active={false} refreshRequest={1} />);
    expect(invoke).not.toHaveBeenCalledWith("embed:reload", expect.anything());
    view.rerender(<EmbedHost kind="hosted-shell" active refreshRequest={1} />);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("embed:reload", { embedId: "embed-1" });
    });
  });
});
