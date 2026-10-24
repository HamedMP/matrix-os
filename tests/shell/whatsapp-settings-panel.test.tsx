// @vitest-environment jsdom
import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WhatsAppSettingsPanel } from "../../packages/ui/src/messaging/WhatsAppSettingsPanel.js";
afterEach(cleanup);
describe("WhatsApp settings", () => {
  it("keeps connection truth but exposes no platform actions for invalid explicit origin", async () => {
    render(<WhatsAppSettingsPanel platformOrigin="https://stage.example/path" scope="invalid-config"
      load={async () => ({ connected: true, maskedSender: "your WhatsApp account", admission: "public", chatId: "chat_stage" })} />);
    await screen.findByText("Connected");
    expect(screen.queryByRole("link", { name: "Manage connection" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Open Matrix Chat" })).toBeNull();
    expect(screen.getByRole("link", { name: "Connection guide" })).toBeTruthy();
  });
  it("keeps configured authority for Connect and Open Matrix Chat without changing WhatsApp links", async () => {
    const configured = { platformOrigin: "https://messaging-stage.example.com" };
    const onOpen = vi.fn().mockResolvedValue(undefined);
    render(<WhatsAppSettingsPanel {...configured} scope="stage-owner" onOpen={onOpen}
      load={async () => ({ connected: true, maskedSender: "your WhatsApp account", admission: "public", chatId: "chat_stage", startUrl: "https://wa.me/13073174314" })} />);
    await screen.findByText("Connected");
    expect(screen.getByRole("link", { name: "Manage connection" }).getAttribute("href"))
      .toBe("https://messaging-stage.example.com/whatsapp/connect");
    const chat = screen.getByRole("link", { name: "Open Matrix Chat" });
    expect(chat.getAttribute("href")).toBe("https://messaging-stage.example.com/open?chat=chat_stage");
    fireEvent.click(chat);
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith("https://messaging-stage.example.com/open?chat=chat_stage"));
    expect(screen.getByRole("link", { name: "Open WhatsApp" }).getAttribute("href"))
      .toBe("https://wa.me/13073174314");
  });
  it("shows owner connection separately from agent readiness and opens safe actions", async () => {
    const load = vi.fn(async () => ({
      connected: true,
      maskedSender: "your WhatsApp account",
      admission: "pilot" as const,
      startUrl: "https://wa.me/13073174314",
      chatId: "chat_whatsapp",
    }));
    render(<WhatsAppSettingsPanel scope="owner" load={load} />);
    await screen.findByText("Connected");
    expect(screen.getByText(/Agents & providers/)).toBeTruthy();
    expect(screen.getByText(/New conversations use Matrix Agent/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open Matrix Chat" }).getAttribute("href"))
      .toBe("https://app.matrix-os.com/open?chat=chat_whatsapp");
    expect(
      screen.getByRole("link", { name: "Open WhatsApp" }).getAttribute("href"),
    ).toBe("https://wa.me/13073174314");
  });
  it("keeps the current connection and actions when opening a link fails, and retries that link", async () => {
    let rejectOpen!: (error: unknown) => void;
    const onOpen = vi.fn().mockImplementationOnce(() => new Promise((_, reject) => { rejectOpen = reject; }))
      .mockResolvedValue(undefined);
    const load = vi.fn(async () => ({ connected: true, maskedSender: "••••1234", admission: "public",
      startUrl: "https://wa.me/13073174314", chatId: "chat_whatsapp" }));
    render(<WhatsAppSettingsPanel scope="owner" load={load} onOpen={onOpen} />);
    await screen.findByText("Connected");
    fireEvent.click(screen.getByRole("link", { name: "Open WhatsApp" }));
    await act(async () => { rejectOpen(new Error("Private Electron browser error")); });
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByText(/Linked account · ••••1234/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open Matrix Chat" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Manage connection" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Could not open this link. Try again.");
    expect(screen.queryByText(/Could not check your connection/)).toBeNull();
    expect(screen.queryByText(/Private Electron/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry link" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(onOpen.mock.calls).toEqual([["https://wa.me/13073174314"], ["https://wa.me/13073174314"]]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Connected")).toBeTruthy();
  });
  it.each(["disconnected", "failed check"] as const)("clears a failed Chat retry while refreshing to %s", async (result) => {
    let resolveRefresh!: (value: unknown) => void;
    let rejectRefresh!: (error: unknown) => void;
    const load = vi.fn().mockResolvedValueOnce({ connected: true, maskedSender: "your WhatsApp account", admission: "public", chatId: "chat_old" })
      .mockImplementationOnce(() => new Promise((resolve, reject) => { resolveRefresh = resolve; rejectRefresh = reject; }));
    const onOpen = vi.fn().mockRejectedValueOnce(new Error("Browser unavailable"));
    render(<WhatsAppSettingsPanel scope="owner" load={load} onOpen={onOpen} />);
    await screen.findByText("Connected");
    fireEvent.click(screen.getByRole("link", { name: "Open Matrix Chat" }));
    await screen.findByRole("button", { name: "Retry link" });
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("button", { name: "Retry link" })).toBeNull();
    await act(async () => {
      if (result === "disconnected") resolveRefresh({ connected: false, admission: "public" });
      else rejectRefresh(new Error("Connection unavailable"));
    });
    if (result === "disconnected") await screen.findByText("Not connected");
    else await screen.findByRole("button", { name: "Try again" });
    expect(screen.queryByRole("link", { name: "Open Matrix Chat" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry link" })).toBeNull();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
  it("ignores a pending old Chat open failure after connection refresh", async () => {
    let rejectOpen!: (error: unknown) => void;
    const onOpen = vi.fn(() => new Promise<void>((_, reject) => { rejectOpen = reject; }));
    const load = vi.fn().mockResolvedValueOnce({ connected: true, maskedSender: "your WhatsApp account", admission: "public", chatId: "chat_old" })
      .mockResolvedValue({ connected: false, admission: "public" });
    render(<WhatsAppSettingsPanel scope="owner" load={load} onOpen={onOpen} />);
    await screen.findByText("Connected");
    fireEvent.click(screen.getByRole("link", { name: "Open Matrix Chat" }));
    fireEvent(window, new Event("focus"));
    await screen.findByText("Not connected");
    await act(async () => { rejectOpen(new Error("Old browser failure")); });
    expect(screen.queryByRole("button", { name: "Retry link" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Open Matrix Chat" })).toBeNull();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
  it("does not offer a failed link from a previous configured platform authority", async () => {
    const load = vi.fn().mockResolvedValue({ connected: true, maskedSender: "your WhatsApp account", admission: "public", chatId: "chat_owner" });
    const onOpen = vi.fn().mockRejectedValueOnce(new Error("Browser unavailable"));
    const view = render(<WhatsAppSettingsPanel platformOrigin="https://first.example.com" scope="owner" load={load} onOpen={onOpen} />);
    await screen.findByText("Connected");
    fireEvent.click(screen.getByRole("link", { name: "Open Matrix Chat" }));
    await screen.findByRole("button", { name: "Retry link" });
    view.rerender(<WhatsAppSettingsPanel platformOrigin="https://second.example.com" scope="owner" load={load} onOpen={onOpen} />);
    await waitFor(() => expect(screen.getByRole("link", { name: "Open Matrix Chat" }).getAttribute("href"))
      .toBe("https://second.example.com/open?chat=chat_owner"));
    expect(screen.queryByRole("button", { name: "Retry link" })).toBeNull();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
  it("ignores a stale account response and refreshes on return", async () => {
    let resolve!: (value: unknown) => void;
    const load = vi
      .fn()
      .mockImplementationOnce(() => new Promise((r) => (resolve = r)))
      .mockResolvedValue({ connected: false, admission: "public" });
    const view = render(<WhatsAppSettingsPanel scope="first" load={load} />);
    view.rerender(<WhatsAppSettingsPanel scope="second" load={load} />);
    await screen.findByText("Not connected");
    resolve({ connected: true, maskedSender: "••••9999", admission: "pilot" });
    expect(screen.queryByText("••••9999")).toBeNull();
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(3));
  });
  it("ignores an older external-open failure after a newer link opened", async () => {
    let rejectOld!: (error: unknown) => void;
    const onOpen = vi.fn().mockImplementationOnce(() => new Promise((_, reject) => { rejectOld = reject; }))
      .mockResolvedValue(undefined);
    render(<WhatsAppSettingsPanel scope="owner" load={async () => ({ connected: false, admission: "public" })} onOpen={onOpen} />);
    await screen.findByText("Not connected");
    fireEvent.click(screen.getByRole("link", { name: "Connect WhatsApp" }));
    await act(async () => { fireEvent.click(screen.getByRole("link", { name: "Connection guide" })); });
    await act(async () => { rejectOld(new Error("Old open failed")); });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Not connected")).toBeTruthy();
  });
  it("coalesces return events during a pending read and refreshes after it settles", async () => {
    let resolveOld!: (value: unknown) => void;
    let resolveCurrent!: (value: unknown) => void;
    const load = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveCurrent = resolve; }));
    render(<WhatsAppSettingsPanel scope="owner" load={load} />);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    fireEvent(window, new Event("focus"));
    fireEvent(document, new Event("visibilitychange"));
    fireEvent(window, new Event("focus"));
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => { resolveOld({ connected: true, maskedSender: "Old account", admission: "public", chatId: "chat_old" }); });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("link", { name: "Open Matrix Chat" })).toBeNull();
    await act(async () => { resolveCurrent({ connected: false, admission: "public" }); });
    await screen.findByText("Not connected");
    expect(screen.queryByRole("link", { name: "Open Matrix Chat" })).toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
  });
  it("refreshes after a rejected pending read when the owner returned meanwhile", async () => {
    let rejectOld!: (reason: unknown) => void;
    const load = vi.fn().mockImplementationOnce(() => new Promise((_, reject) => { rejectOld = reject; }))
      .mockResolvedValue({ connected: false, admission: "public" });
    render(<WhatsAppSettingsPanel scope="owner" load={load} />);
    fireEvent(window, new Event("focus"));
    await act(async () => { rejectOld(new Error("Unavailable")); });
    await screen.findByText("Not connected");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
  });
  it("does not carry a queued refresh across an account switch or unmount", async () => {
    let resolveOld!: (value: unknown) => void;
    const load = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValue({ connected: false, admission: "public" });
    const view = render(<WhatsAppSettingsPanel scope="first" load={load} />);
    fireEvent(window, new Event("focus"));
    view.rerender(<WhatsAppSettingsPanel scope="second" load={load} />);
    await screen.findByText("Not connected");
    await act(async () => { resolveOld({ connected: true, maskedSender: "Old account", admission: "public", chatId: "chat_old" }); });
    expect(screen.queryByRole("link", { name: "Open Matrix Chat" })).toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
    view.unmount();
    fireEvent(window, new Event("focus"));
    expect(load).toHaveBeenCalledTimes(2);
  });
  it("handles errors without leaking provider or database details", async () => {
    render(
      <WhatsAppSettingsPanel
        scope="owner"
        load={async () => {
          throw Error("postgres private password");
        }}
      />,
    );
    await screen.findByRole("alert");
    expect(screen.queryByText(/postgres/)).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});
it("does not overlap requests when return events repeat while checking", async () => {
  const load = vi.fn(() => new Promise(() => {}));
  render(<WhatsAppSettingsPanel scope="busy" load={load} />);
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  fireEvent(window, new Event("focus"));
  fireEvent(window, new Event("focus"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(load).toHaveBeenCalledTimes(1);
});
import { SlackInstallPanel } from "../../packages/ui/src/messaging/SlackInstallPanel";
it("embeds Slack beneath the shared Messaging heading without repeating it", () => {
  render(<SlackInstallPanel showHeading={false} />);
  expect(screen.queryByRole("heading", { name: "Messaging" })).toBeNull();
  expect(screen.getByRole("heading", { name: "Slack" })).toBeTruthy();
});
