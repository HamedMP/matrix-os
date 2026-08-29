// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import BrowserTab from "@desktop/renderer/src/features/browser/BrowserTab";
import { invoke } from "@desktop/renderer/src/lib/operator";

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
    vi.mocked(invoke).mockReset();
    mocks.embedRender.mockReset();
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

  it("offers browser session settings and explains password-vault safety", () => {
    render(<BrowserTab active />);
    fireEvent.click(screen.getByRole("button", { name: "Browser settings" }));

    const settings = screen.getByRole("region", { name: "Browser settings" });
    expect((within(settings).getByRole("checkbox", { name: "Restore previous tabs" }) as HTMLInputElement).checked).toBe(true);
    expect(within(settings).getByText("Cookies and sign-ins persist in the browser profile.")).toBeTruthy();
    expect(within(settings).getByText(/Password saving requires an OS-encrypted browser vault/)).toBeTruthy();
  });
});
