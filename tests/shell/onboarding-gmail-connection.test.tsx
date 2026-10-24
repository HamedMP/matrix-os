// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GmailConnectionChoice } from "@matrix-os/ui";
import { useShellOnboardingIntegrations } from "@/components/onboarding-widget/use-shell-onboarding-integrations";

const GATEWAY = "https://pilot.example.test/vm/owner";
const options = { methods: ["matrix", "pipedream"], defaultMethod: "pipedream" };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function scene(fetchFn: typeof fetch, dispatch = vi.fn(), intervals = [0, 0]) {
  function Scene() {
    const integrations = useShellOnboardingIntegrations(dispatch, { gatewayUrl: GATEWAY, fetchFn, pollIntervals: intervals });
    return <><button onClick={() => integrations.connectApp("gmail")}>Connect Gmail app</button>
      <button onClick={() => integrations.connectApp("github")}>Connect GitHub app</button>
      <output>{integrations.connectingService ?? "idle"}</output>
      <GmailConnectionChoice choice={integrations.gmailChoice} /></>;
  }
  return render(<Scene />);
}
function transport(connectResponse: unknown, receipt: unknown = { status: "pending" }, connections: unknown[] = []) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/gmail/connection-options")) return json(options);
    if (url.endsWith("/available")) return json({ services: [{ id: "gmail", name: "Gmail", category: "personal" }] });
    if (url.endsWith("/connect")) return json(connectResponse);
    if (url.includes("/gmail/pipedream/attempts/")) return json(receipt);
    if (url.endsWith("/sync")) return json({ services: connections });
    if (url.endsWith("/api/integrations")) return json(connections);
    throw new Error("Unexpected test route");
  });
}
function popup() {
  const result = { closed: false, opener: {}, location: { href: "about:blank" }, close: vi.fn() };
  vi.spyOn(window, "open").mockReturnValue(result as unknown as Window);
  return result;
}
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true; });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false; });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("onboarding Gmail connection", () => {
  it.each(["matrix", "pipedream"])("waits for the owner's explicit %s choice before opening consent", async method => {
    popup();
    const fetchFn = transport({ url: "https://consent.example.test/gmail" });
    const dispatch = vi.fn();
    scene(fetchFn, dispatch);
    fireEvent.click(screen.getByText("Connect Gmail app"));
    expect(window.open).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalledWith({ type: "connect.started" });
    const name = method === "matrix" ? /Connect with Matrix/ : /Connect with Pipedream/;
    fireEvent.click(await screen.findByRole("button", { name }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledWith(`${GATEWAY}/api/integrations/connect`, expect.objectContaining({
      body: JSON.stringify({ service: "gmail", connectionMethod: method }),
    })));
  });

  it("cancels the chooser without starting an attempt or leaving Connecting", async () => {
    popup(); const fetchFn = transport({ url: "https://consent.example.test/gmail" }); const dispatch = vi.fn();
    scene(fetchFn, dispatch);
    fireEvent.click(screen.getByText("Connect Gmail app"));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("idle")).toBeTruthy();
    expect(window.open).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalledWith({ type: "connect.started" });
  });

  it.each(["pending", "failed", "expired"])("does not confuse unrelated inventory with its %s receipt", async status => {
    popup();
    const fetchFn = transport({ url: "https://consent.example.test/gmail", attemptId: "10000000-0000-4000-8000-000000000001" }, { status }, [{ id: "unrelated", service: "gmail", status: "active" }]);
    const dispatch = vi.fn(); scene(fetchFn, dispatch);
    fireEvent.click(screen.getByText("Connect Gmail app"));
    fireEvent.click(await screen.findByRole("button", { name: /Connect with Pipedream/ }));
    await waitFor(() => expect(dispatch).toHaveBeenCalledWith({ type: "connect.failed", service: "gmail" }));
    expect(dispatch).not.toHaveBeenCalledWith({ type: "connect.succeeded", service: "gmail" });
    expect(fetchFn.mock.calls.some(([url]) => String(url).endsWith("/sync"))).toBe(false);
    expect(screen.getByText("idle")).toBeTruthy();
  });

  it("settles the exact successful receipt even for an already active account reconnect", async () => {
    popup();
    const fetchFn = transport({ url: "https://consent.example.test/gmail", attemptId: "10000000-0000-4000-8000-000000000001" }, { status: "succeeded", accountId: "20000000-0000-4000-8000-000000000001" }, [{ id: "20000000-0000-4000-8000-000000000001", service: "gmail", status: "active" }]);
    const dispatch = vi.fn(); scene(fetchFn, dispatch);
    fireEvent.click(screen.getByText("Connect Gmail app"));
    fireEvent.click(await screen.findByRole("button", { name: /Connect with Pipedream/ }));
    await waitFor(() => expect(dispatch).toHaveBeenCalledWith({ type: "connect.succeeded", service: "gmail" }));
    expect(screen.getByText("idle")).toBeTruthy();
    expect(fetchFn.mock.calls.some(([url]) => String(url).endsWith("/attempts/10000000-0000-4000-8000-000000000001"))).toBe(true);
  });

  it("closes a superseded popup and ignores its late start response", async () => {
    const first = popup();
    const second = { closed: false, opener: {}, location: { href: "about:blank" }, close: vi.fn() };
    vi.mocked(window.open).mockReturnValueOnce(first as unknown as Window).mockReturnValueOnce(second as unknown as Window);
    let release: (response: Response) => void = () => undefined;
    const base = transport({ url: "https://consent.example.test/github" });
    const fetchFn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => String(input).endsWith("/connect") && String(init?.body).includes("gmail")
      ? new Promise<Response>(resolve => { release = resolve; }) : base(input));
    const dispatch = vi.fn(); scene(fetchFn, dispatch);
    fireEvent.click(screen.getByText("Connect Gmail app"));
    fireEvent.click(await screen.findByRole("button", { name: /Connect with Matrix/ }));
    fireEvent.click(screen.getByText("Connect GitHub app"));
    expect(first.close).toHaveBeenCalled();
    await act(async () => release(json({ url: "https://consent.example.test/stale" })));
    expect(first.location.href).toBe("about:blank");
    expect(dispatch).not.toHaveBeenCalledWith({ type: "connect.succeeded", service: "gmail" });
  });
});
