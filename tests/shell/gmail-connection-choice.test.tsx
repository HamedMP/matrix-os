// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/gateway", () => ({ getGatewayUrl: () => "https://gateway.test", getGatewayWs: () => "wss://gateway.test/ws" }));
vi.mock("@/lib/websocket-auth", () => ({ buildAuthenticatedWebSocketUrl: () => new Promise(() => {}) }));
import { IntegrationsSection } from "../../shell/src/components/settings/sections/IntegrationsSection.js";
import { SHELL_Z_INDEX } from "../../shell/src/lib/shell-layering.js";
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true; });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false; });
});
const gmail = { id: "gmail", name: "Gmail", category: "google", authType: "oauth" };
function prepare(options: unknown, status = 200) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/connection-options")) return { ok: status === 200, status, json: async () => options };
    if (url.endsWith("/available")) return { ok: true, json: async () => [gmail] };
    if (url.endsWith("/connect")) return { ok: true, json: async () => ({ url: "https://pipedream.com/connect/test" }) };
    return { ok: true, json: async () => [] };
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(window, "open").mockReturnValue({ location: { href: "about:blank" }, close: vi.fn() } as unknown as Window);
  render(<div style={{ position: "fixed", zIndex: SHELL_Z_INDEX.settings }}><IntegrationsSection /></div>);
  return fetchMock;
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("Gmail connection choices in shared OS views", () => {
  it("opens in the browser modal layer above Web Settings and dismisses with Escape", async () => {
    prepare({ methods: ["matrix", "pipedream"], defaultMethod: "matrix" });
    fireEvent.click(await screen.findByRole("button", { name: "Connect Gmail" }));
    const dialog = await screen.findByRole("dialog", { name: "Connect Gmail" });
    expect(dialog.tagName).toBe("DIALOG");
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledOnce();
    expect((dialog as HTMLDialogElement).open).toBe(true);
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(screen.queryByRole("dialog", { name: "Connect Gmail" })).toBeNull();
    expect(window.open).not.toHaveBeenCalled();
  });
  it.each(["matrix", "pipedream"])("sends the explicitly selected %s method", async method => {
    const fetchMock = prepare({ methods: ["matrix", "pipedream"], defaultMethod: "matrix" });
    fireEvent.click(await screen.findByRole("button", { name: "Connect Gmail" }));
    fireEvent.click(await screen.findByRole("button", { name: method === "matrix" ? "Connect with Matrix (internal preview)" : "Connect with Pipedream" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/connect"))).toBe(true));
    const request = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/connect"));
    expect(JSON.parse((request?.[1] as RequestInit).body as string)).toEqual({ service: "gmail", connectionMethod: method });
  });
  it("cancels without opening consent or minting a connection", async () => {
    const fetchMock = prepare({ methods: ["matrix", "pipedream"], defaultMethod: "matrix" });
    fireEvent.click(await screen.findByRole("button", { name: "Connect Gmail" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(window.open).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/connect"))).toBe(false);
  });
  it("fails discovery safely and lets the user retry", async () => {
    const fetchMock = prepare({}, 500);
    fireEvent.click(await screen.findByRole("button", { name: "Connect Gmail" }));
    expect(await screen.findByText("Could not load Gmail connection options. Try again.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect with Matrix (internal preview)" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/connection-options")).length).toBe(2));
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/connect"))).toBe(false);
  });
  it("uses Pipedream when the older runtime lacks discovery", async () => {
    const fetchMock = prepare({}, 404);
    const button = await screen.findByRole("button", { name: "Connect Gmail" });
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/connection-options"))).toBe(true));
    fireEvent.click(button);
    // Discovery may finish after the initial render; a visible PD-only choice remains safe.
    const pd = screen.queryByRole("button", { name: "Connect with Pipedream" });
    if (pd) fireEvent.click(pd);
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/connect"))).toBe(true));
    expect(screen.queryByRole("button", { name: "Connect with Matrix (internal preview)" })).toBeNull();
  });
  it("ignores a repeated method click while consent starts", async () => {
    const fetchMock = prepare({ methods: ["matrix", "pipedream"], defaultMethod: "matrix" });
    fireEvent.click(await screen.findByRole("button", { name: "Connect Gmail" }));
    const choice = await screen.findByRole("button", { name: "Connect with Pipedream" });
    fireEvent.click(choice); fireEvent.click(choice);
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/connect")).length).toBe(1));
    expect(window.open).toHaveBeenCalledTimes(1);
  });

});
