// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import BrowserTab from "@desktop/renderer/src/features/browser/BrowserTab";
import BrowserSecretImportView, { selectImportHost } from "@desktop/renderer/src/features/browser/BrowserSecretImportView";
import { invoke } from "@desktop/renderer/src/lib/operator";
import { useBrowserNavigation } from "@desktop/renderer/src/stores/browser-navigation";

const mocks = vi.hoisted(() => ({ embedRender: vi.fn() }));

vi.mock("@desktop/renderer/src/lib/operator", () => ({ invoke: vi.fn() }));
vi.mock("@desktop/renderer/src/features/embeds/EmbedHost", () => ({
  default: ({ kind, url }: { kind: string; url: string }) => {
    mocks.embedRender(kind, url);
    return <div data-testid="embed">{kind}:{url}</div>;
  },
}));

describe("BrowserTab", () => {
  it("caps combined preview and manual website selection at the import limit", () => {
    const selected = Array.from({ length: 5_000 }, (_, index) => `site${index}.example`);
    expect(selectImportHost(selected, "extra.example")).toBe(selected);
    expect(selectImportHost(selected.slice(1), "extra.example")).toHaveLength(5_000);
    expect(selectImportHost(selected, "site1.example")).toBe(selected);
  });

  it("lets the owner choose which local 1Password account to import", async () => {
    const accountId = "B".repeat(26);
    vi.mocked(invoke).mockImplementation(async (channel) => {
      if (channel === "browser:list-secret-sources") return { sources: [] } as never;
      if (channel === "browser:list-1password-accounts") return { accounts: [
        { id: "A".repeat(26), label: "First · first.1password.com" },
        { id: accountId, label: "Second · second.1password.com" },
      ] } as never;
      if (channel === "browser:list-1password") return { items: [
        { id: "abcdefghijkl", title: "Selected login", origin: "https://example.com" },
      ] } as never;
      if (channel === "browser:import-1password") return { imported: 1, skipped: 0 } as never;
      return { ok: true } as never;
    });
    render(<BrowserSecretImportView />);
    fireEvent.click(screen.getByRole("button", { name: "Choose 1Password logins" }));
    const account = await screen.findByRole("button", { name: /Second · second.1password.com/ });
    fireEvent.click(account);
    expect(await screen.findByText("Selected login")).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith("browser:list-1password", { accountId });
    fireEvent.click(screen.getByRole("checkbox", { name: /Selected login/ }));
    fireEvent.click(screen.getByRole("button", { name: "Import selected logins (1)" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("browser:import-1password", {
      accountId, ids: ["abcdefghijkl"],
    }));
  });

  beforeEach(() => {
    window.localStorage.clear();
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (channel) => {
      if (channel === "browser:list-secret-sources") return { sources: [] } as never;
      return { ok: true } as never;
    });
    mocks.embedRender.mockReset();
    useBrowserNavigation.setState(useBrowserNavigation.getInitialState(), true);
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
    expect(within(settings).getByText(/Passwords you import are stored in an OS-encrypted local vault/)).toBeTruthy();
  });

  it("imports selected local browser pages and opens them from Saved pages", async () => {
    vi.mocked(invoke).mockImplementation(async (channel) => {
      if (channel === "browser:list-import-sources") return {
        sources: [{ id: "arc:sidebar", browser: "Arc", profile: "Sidebar", pageCount: 1 }],
      } as never;
      if (channel === "browser:import-pages") return {
        pages: [{ title: "Project", url: "https://example.com/project", folder: "Arc tabs" }],
      } as never;
      if (channel === "browser:list-secret-sources") return { sources: [] } as never;
      return { ok: true } as never;
    });
    const first = render(<BrowserTab active />);
    fireEvent.click(screen.getByRole("button", { name: "Browser settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Import from another browser" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Import 1 page from Arc Sidebar" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Import 1 page from Arc Sidebar" }));
    await waitFor(() => expect(screen.getByText("Project")).toBeTruthy());
    expect(window.localStorage.getItem("matrix.desktop.browser.saved-pages.v1")).toContain("https://example.com/project");

    first.unmount();
    render(<BrowserTab active />);
    fireEvent.click(screen.getByRole("button", { name: "Saved pages" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Project" }));
    expect(screen.getByTestId("embed").textContent).toBe("browser:https://example.com/project");
  });

  it("saves the current public page alongside imported pages", () => {
    render(<BrowserTab active />);
    fireEvent.change(screen.getByRole("textbox", { name: "Browser address" }), {
      target: { value: "https://example.com/current" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    fireEvent.click(screen.getByRole("button", { name: "Save current page" }));
    fireEvent.click(screen.getByRole("button", { name: "Saved pages" }));
    expect(screen.getByRole("button", { name: "Open example.com" })).toBeTruthy();
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
