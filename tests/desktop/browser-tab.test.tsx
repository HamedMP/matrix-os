// @vitest-environment jsdom

import React from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import BrowserTab from "@desktop/renderer/src/features/browser/BrowserTab";
import { invoke } from "@desktop/renderer/src/lib/operator";
import { useBrowserNavigation } from "@desktop/renderer/src/stores/browser-navigation";
import { useConnection } from "@desktop/renderer/src/stores/connection";

const mocks = vi.hoisted(() => ({ embedRender: vi.fn() }));

vi.mock("@desktop/renderer/src/lib/operator", () => ({ invoke: vi.fn() }));
vi.mock("@desktop/renderer/src/features/embeds/EmbedHost", () => ({
  default: ({ kind, url }: { kind: string; url: string }) => {
    mocks.embedRender(kind, url);
    return <div data-testid="embed">{kind}:{url}</div>;
  },
}));

describe("BrowserTab", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.mocked(invoke).mockReset();
    mocks.embedRender.mockReset();
    useBrowserNavigation.setState(useBrowserNavigation.getInitialState(), true);
    useConnection.setState(useConnection.getInitialState(), true);
  });

  it("keeps loopback navigation inside the selected runtime embed", () => {
    render(<BrowserTab active />);

    fireEvent.change(screen.getByRole("textbox", { name: "Browser address" }), {
      target: { value: "127.0.0.1:3000/docs" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));

    expect(screen.getByTestId("embed").textContent).toBe("browser:http://127.0.0.1:3000/docs");
    expect(invoke).not.toHaveBeenCalledWith("shell:open-external", expect.anything());
  });

  it("remounts the runtime embed when the same normalized address is submitted again", () => {
    render(<BrowserTab active />);
    const address = screen.getByRole("textbox", { name: "Browser address" });
    fireEvent.change(address, { target: { value: "127.0.0.1:3000/docs" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    const renderCount = mocks.embedRender.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "Go" }));

    expect(mocks.embedRender.mock.calls.length).toBeGreaterThan(renderCount);
  });

  it("opens public URLs and searches inside the Desktop Browser", () => {
    render(<BrowserTab active />);

    const address = screen.getByRole("textbox", { name: "Browser address" });
    fireEvent.change(address, { target: { value: "127.0.0.1:3000" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(screen.getByTestId("embed")).toBeTruthy();

    fireEvent.change(address, { target: { value: "Matrix OS docs" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));

    expect(screen.getByTestId("embed").textContent).toBe(
      "browser:https://www.google.com/search?q=Matrix+OS+docs",
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it("opens, switches, and closes multiple browser tabs", () => {
    render(<BrowserTab active />);

    const tablist = screen.getByRole("tablist", { name: "Browser tabs" });
    expect(within(tablist).getAllByRole("tab")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "New browser tab" }));
    expect(within(tablist).getAllByRole("tab")).toHaveLength(2);

    fireEvent.change(screen.getByRole("textbox", { name: "Browser address" }), {
      target: { value: "https://example.com/docs" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(screen.getByTestId("embed").textContent).toBe("browser:https://example.com/docs");

    fireEvent.click(within(tablist).getAllByRole("tab")[0]!);
    expect(screen.queryByTestId("embed")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close browser tab 2" }));
    expect(within(tablist).getAllByRole("tab")).toHaveLength(1);
  });

  it("restores the previous tabs and active URL after remount", () => {
    const first = render(<BrowserTab active />);
    fireEvent.change(screen.getByRole("textbox", { name: "Browser address" }), {
      target: { value: "https://example.com/previous" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    first.unmount();

    render(<BrowserTab active />);
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Browser address" }).value)
      .toBe("https://example.com/previous");
    expect(screen.getByTestId("embed").textContent).toBe("browser:https://example.com/previous");
  });

  it("does not restore a Browser session after the renderer session ends", () => {
    const first = render(<BrowserTab active />);
    fireEvent.change(screen.getByRole("textbox", { name: "Browser address" }), {
      target: { value: "http://localhost:4173" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    first.unmount();
    window.sessionStorage.clear();

    render(<BrowserTab active />);
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Browser address" }).value)
      .toBe("");
    expect(screen.queryByTestId("embed")).toBeNull();
  });

  it("keeps persisted localhost sessions scoped to their Matrix runtime", () => {
    useConnection.setState({
      status: "signed-in",
      handle: "alice",
      platformHost: "https://matrix.example",
      runtimeSlot: "primary",
    });
    useBrowserNavigation.getState().request("http://localhost:4173");
    const view = render(<BrowserTab active />);
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Browser address" }).value)
      .toBe("http://localhost:4173/");

    act(() => useConnection.setState({ runtimeSlot: "secondary" }));
    view.rerender(<BrowserTab active />);
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Browser address" }).value)
      .toBe("");
    expect(screen.queryByTestId("embed")).toBeNull();

    act(() => useConnection.setState({ runtimeSlot: "primary" }));
    view.rerender(<BrowserTab active />);
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Browser address" }).value)
      .toBe("http://localhost:4173/");

    act(() => useConnection.setState({ authGeneration: 1 }));
    view.rerender(<BrowserTab active />);
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Browser address" }).value)
      .toBe("");
    expect(screen.queryByTestId("embed")).toBeNull();
  });

  it("keeps queued navigation for the runtime that requested it", () => {
    useConnection.setState({
      status: "signed-in",
      handle: "alice",
      platformHost: "https://matrix.example",
      runtimeSlot: "primary",
      authGeneration: 4,
    });
    useBrowserNavigation.getState().request("http://localhost:4173");
    useConnection.setState({ runtimeSlot: "secondary" });
    const view = render(<BrowserTab active />);

    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Browser address" }).value)
      .toBe("");
    expect(useBrowserNavigation.getState().pending?.url).toBe("http://localhost:4173/");

    act(() => useConnection.setState({ runtimeSlot: "primary" }));
    view.rerender(<BrowserTab active />);
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Browser address" }).value)
      .toBe("http://localhost:4173/");
    expect(useBrowserNavigation.getState().pending).toBeNull();
  });

  it("queues launches from multiple runtimes without overwriting either one", () => {
    useConnection.setState({
      status: "signed-in",
      handle: "alice",
      platformHost: "https://matrix.example",
      runtimeSlot: "primary",
      authGeneration: 4,
    });
    useBrowserNavigation.getState().request("http://localhost:4173");
    useConnection.setState({ runtimeSlot: "secondary" });
    useBrowserNavigation.getState().request("http://localhost:8080");
    const view = render(<BrowserTab active />);
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Browser address" }).value)
      .toBe("http://localhost:8080/");

    act(() => useConnection.setState({ runtimeSlot: "primary" }));
    view.rerender(<BrowserTab active />);
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Browser address" }).value)
      .toBe("http://localhost:4173/");
    expect(useBrowserNavigation.getState().pending).toBeNull();
  });

  it("takes a queued launch for the active runtime even when another runtime is pending", () => {
    useConnection.setState({
      status: "signed-in",
      handle: "alice",
      platformHost: "https://matrix.example",
      runtimeSlot: "primary",
      authGeneration: 4,
    });
    useBrowserNavigation.getState().request("http://localhost:4173");
    useConnection.setState({ runtimeSlot: "secondary" });
    useBrowserNavigation.getState().request("http://localhost:8080");
    useConnection.setState({ runtimeSlot: "primary" });
    const view = render(<BrowserTab active />);

    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Browser address" }).value)
      .toBe("http://localhost:4173/");

    act(() => useConnection.setState({ runtimeSlot: "secondary" }));
    view.rerender(<BrowserTab active />);
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Browser address" }).value)
      .toBe("http://localhost:8080/");
    expect(useBrowserNavigation.getState().pending).toBeNull();
  });

  it("retains two accepted launches queued from the same runtime", () => {
    useBrowserNavigation.getState().request("https://example.com/first");
    useBrowserNavigation.getState().request("https://example.com/second");

    expect([
      ...useBrowserNavigation.getState().queued,
      useBrowserNavigation.getState().pending,
    ].filter(Boolean).map((request) => request?.url)).toEqual([
      "https://example.com/first",
      "https://example.com/second",
    ]);
  });

  it("rejects queue overflow without discarding an accepted launch", () => {
    const requests = Array.from({ length: 8 }, (_, index) =>
      useBrowserNavigation.getState().request(`https://example.com/${index}`));

    expect(requests.every((requestId) => requestId !== null)).toBe(true);
    expect(useBrowserNavigation.getState().request("https://example.com/overflow")).toBeNull();
    expect([
      ...useBrowserNavigation.getState().queued,
      useBrowserNavigation.getState().pending,
    ].filter(Boolean).map((request) => request?.url)).toEqual(
      Array.from({ length: 8 }, (_, index) => `https://example.com/${index}`),
    );
  });

  it("offers browser session settings and explains password-vault safety", () => {
    render(<BrowserTab active />);
    fireEvent.click(screen.getByRole("button", { name: "Browser settings" }));

    const settings = screen.getByRole("region", { name: "Browser settings" });
    expect((within(settings).getByRole("checkbox", { name: "Restore previous tabs" }) as HTMLInputElement).checked).toBe(true);
    expect(within(settings).getByText("Cookies and sign-ins persist in the browser profile.")).toBeTruthy();
    expect(within(settings).getByText(/Password saving requires an OS-encrypted browser vault/)).toBeTruthy();
  });

  it("opens requested Help pages in Matrix Browser with an external-browser option", () => {
    useBrowserNavigation.getState().request("https://matrix-os.com/docs");

    render(<BrowserTab active />);

    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Browser address" }).value)
      .toBe("https://matrix-os.com/docs");
    expect(screen.getByTestId("embed").textContent).toBe("browser:https://matrix-os.com/docs");
    expect(useBrowserNavigation.getState().pending).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open current page in external browser" }));
    expect(invoke).toHaveBeenCalledWith("shell:open-external", {
      url: "https://matrix-os.com/docs",
    });
  });

  it("does not offer the external-browser escape hatch for tunneled runtime pages", () => {
    useBrowserNavigation.getState().request("http://127.0.0.1:3000");

    render(<BrowserTab active />);

    expect(screen.getByTestId("embed").textContent).toBe("browser:http://127.0.0.1:3000/");
    expect(screen.queryByRole("button", { name: "Open current page in external browser" })).toBeNull();
  });

  it("rejects oversized cross-app browser navigation requests", () => {
    expect(useBrowserNavigation.getState().request("x".repeat(4_097))).toBeNull();
    expect(useBrowserNavigation.getState().pending).toBeNull();
  });
});
