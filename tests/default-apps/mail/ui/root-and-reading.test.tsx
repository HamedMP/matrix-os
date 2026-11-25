// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../../../home/apps/_shared/office-ui";
import { ProviderError, type AttachmentContent } from "../../../../home/apps/_shared/office-accounts/types/mail";
import { createMailStore, noMailCache, type MailAccountEntry } from "../../../../home/apps/mail/src/model";
import { MailRoot } from "../../../../home/apps/mail/src/ui/MailRoot";
import { FakeProvider } from "../model/fake-provider";
import { GMAIL, GMAIL_FOLDERS, message, summary, thread } from "../model/fixtures";
import { fakeBridge, NOW, renderWorkspace } from "./harness";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function renderRoot(loadAccounts: () => Promise<MailAccountEntry[]>) {
  const createStore = (options: Parameters<typeof createMailStore>[0]) =>
    createMailStore({ ...options, cache: noMailCache, now: () => NOW, timeZone: "UTC" });
  return render(
    <ToastProvider>
      <MailRoot loadAccounts={loadAccounts} createStore={createStore} bridge={fakeBridge()} now={() => NOW} timeZone="UTC" />
    </ToastProvider>,
  );
}

describe("connection states", () => {
  it("explains how to connect Gmail or Outlook when no account is connected, and checks again", async () => {
    const loader = vi.fn(async () => [] as MailAccountEntry[]);
    renderRoot(loader);
    expect(screen.getByLabelText("Finding your mail accounts")).toBeTruthy();
    expect(await screen.findByText("Connect your mail")).toBeTruthy();
    expect(document.body.textContent).toContain("Settings > Integrations");
    expect(document.body.textContent).toMatch(/Gmail or Outlook/);
    fireEvent.click(screen.getByRole("button", { name: "I have connected an account" }));
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
  });

  it("shows a generic error with retry when the accounts cannot be loaded", async () => {
    const loader = vi.fn(async (): Promise<MailAccountEntry[]> => {
      throw new Error("token=secret at /home/owner/.config");
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    renderRoot(loader);
    expect(await screen.findByText("Your mail accounts could not be loaded")).toBeTruthy();
    expect(document.body.textContent).not.toContain("secret");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
  });

  it("says when this host offers no integrations", async () => {
    renderRoot(async () => {
      throw new ProviderError("not_supported");
    });
    expect(await screen.findByText("Mail accounts are not available here")).toBeTruthy();
  });

  it("opens the workspace for connected accounts", async () => {
    const provider = new FakeProvider(GMAIL_FOLDERS);
    provider.lists.INBOX = [summary("t1", { subject: "Quarterly plan" })];
    renderRoot(async () => [{ account: GMAIL, provider }]);
    expect(await screen.findByText("Quarterly plan")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Inbox/ }).getAttribute("aria-current")).toBe("page");
  });
});

describe("reading pane", () => {
  const conversation = thread("t1", [
    message("m1", { bodyText: "First message body", from: { name: "Alice", address: "alice@example.com" } }),
    message("m2", {
      bodyText: "Latest reply",
      from: { name: "Bob Jones", address: "bob@example.com" },
      to: [{ name: "Me", address: "me@example.com" }, { name: "Carol", address: "carol@example.com" }],
      attachments: [
        { id: "a1", name: "Contract.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 2048 },
        { id: "a2", name: "photo.png", mimeType: "image/png", size: 10 },
        { id: "a3", name: "logo.png", mimeType: "image/png", size: 10, inline: true },
      ],
    }),
  ]);

  async function openConversation() {
    const harness = await renderWorkspace([summary("t1", { subject: "Plans", messageCount: 2 })], (p) => {
      p.threads.t1 = conversation;
      p.getAttachment = async (_messageId: string, attachmentId: string): Promise<AttachmentContent> =>
        ({ name: attachmentId, mimeType: "application/octet-stream", size: 3, contentBase64: "AQID" });
    });
    await act(async () => {
      fireEvent.click(screen.getAllByRole("row")[0]);
    });
    await screen.findByRole("heading", { name: "Plans" });
    return harness;
  }

  it("collapses earlier messages, expands the latest and discloses recipients", async () => {
    await openConversation();
    const first = screen.getByRole("article", { name: "Message from Alice" });
    const latest = screen.getByRole("article", { name: "Message from Bob Jones" });
    expect(first.className).toContain("is-collapsed");
    expect(within(first).queryByTitle("Message from Alice")).toBeNull();
    expect(within(latest).getByTitle("Message from Bob Jones").tagName).toBe("IFRAME");
    const disclosure = within(latest).getByRole("button", { name: "to me, Carol" });
    fireEvent.click(disclosure);
    expect(within(latest).getByText("Carol <carol@example.com>", { exact: false })).toBeTruthy();
    fireEvent.click(within(first).getByRole("button"));
    expect(screen.getByRole("article", { name: "Message from Alice" }).className).not.toContain("is-collapsed");
  });

  it("opens a .docx attachment in Docs through the open-with request and lists no inline images", async () => {
    const { bridge } = await openConversation();
    const write = vi.fn(async (path: string) => ({ path }));
    const openWith = vi.fn(async () => undefined);
    bridge.files = { write, openWith };
    expect(screen.queryByRole("button", { name: /logo\.png/ })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open Contract.docx in Docs" }));
    });
    await waitFor(() => expect(openWith).toHaveBeenCalledWith("Documents/Mail attachments/Contract.docx"));
    expect(write.mock.calls[0][1]).toEqual(new Uint8Array([1, 2, 3]));
    expect(write.mock.calls[0][2]).toEqual({ ifVersion: null, createParents: true });
    expect(await screen.findByText("Opened in Docs")).toBeTruthy();
  });

  it("downloads other attachments", async () => {
    await openConversation();
    const createObjectURL = vi.fn(() => "blob:x");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Download photo.png" }));
    });
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(await screen.findByText("Downloaded photo.png")).toBeTruthy();
  });

  it("starts a reply in the composer slot and never sends without the Send button", async () => {
    const { provider } = await openConversation();
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Reply" })[0]);
    });
    const composer = await screen.findByRole("region", { name: "Reply" });
    expect(within(composer).getByLabelText("Subject")).toBeTruthy();
    expect(provider.calls.sendDraft).toHaveLength(0);
    await act(async () => {
      fireEvent.click(within(composer).getByRole("button", { name: "Send" }));
    });
    await waitFor(() => expect(provider.calls.sendDraft).toHaveLength(1));
  });
});

describe("layout", () => {
  it("restores and saves pane sizes through the app's key-value store", async () => {
    const { bridge } = await renderWorkspace([summary("t1")]);
    expect(bridge.readData).toHaveBeenCalledWith("mail-layout");
    const handle = screen.getByRole("separator", { name: "Resize folder list" });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    await waitFor(() => expect(bridge.data["mail-layout"]).toEqual({ rail: 248, list: 400 }), { timeout: 2000 });
  });
});
