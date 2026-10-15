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
