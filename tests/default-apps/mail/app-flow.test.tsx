// @vitest-environment jsdom
/**
 * The Mail app end to end in jsdom: the real App over a fake host bridge
 * (raw Gmail and Microsoft Graph JSON, an in-memory home with real fixture
 * files, a canned model). Walks acceptance check 5 of spec 2710: list, read,
 * search, file and draft on Gmail and Outlook; an agent draft shows redlines;
 * send requires a click.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../../home/apps/mail/src/App";
import { AGENT_REPLY, OUTLOOK_ARCHIVE_ID, XLSX_BYTES, fakeHost, toBase64, type FakeHost } from "./app-flow-host";

let host: FakeHost;

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  host = fakeHost();
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { MatrixOS?: unknown }).MatrixOS;
  vi.restoreAllMocks();
});

const rows = () => screen.queryAllByRole("row");
const row = (subject: string) => rows().find((el) => within(el).queryAllByText(subject).length > 0);
const sends = () => host.bridge.calls.filter((call) => call.action === "send_draft" || call.action === "send_message");
const frameDoc = (container: HTMLElement) => new DOMParser().parseFromString(container.querySelector("iframe")?.getAttribute("srcdoc") ?? "", "text/html");

async function mountApp() {
  host.install();
  const view = render(<App />);
  await waitFor(() => expect(row("Review – Q3")).toBeTruthy(), { timeout: 4000 });
  await waitFor(() => expect(row("RE: Budget") ?? row("Budget")).toBeTruthy());
  return view;
}

describe("Mail app journey", () => {
  it("lists both mailboxes, reads, drafts with the agent as a redline, and sends only on the Send click", async () => {
    await mountApp();
    const rail = screen.getByRole("navigation", { name: "Mailboxes" });
    expect(within(rail).getByText("All inboxes")).toBeTruthy();
    expect(within(rail).getByRole("region", { name: "Personal" })).toBeTruthy();
    expect(within(rail).getByRole("region", { name: "Work" })).toBeTruthy();
    expect(row("Lunch?")).toBeTruthy();
    expect(host.bridge.calls.every((call) => call.label === "Personal" || call.label === "Work")).toBe(true);

    // Read: the newest message is expanded in a sandboxed frame; scripts are gone.
    await act(async () => {
      fireEvent.click(row("Review – Q3")!);
    });
    const reading = screen.getByRole("region", { name: "Reading pane" });
    await waitFor(() => expect(within(reading).getByRole("heading", { name: "Review – Q3" })).toBeTruthy());
    const latest = within(reading).getByRole("article", { name: "Message from Bob Stone" });
    const body = frameDoc(latest);
    expect(body.body.textContent).toContain("Thursday works & café is booked");
    expect(latest.querySelector("iframe")?.getAttribute("sandbox")).not.toContain("allow-scripts");
    const earlier = within(reading).getByRole("article", { name: "Message from Lovelace, Ada" });
    expect(earlier.textContent).toContain("Can we move the review to Thursday?");
    expect(frameDoc(earlier).querySelector("script")).toBeNull();

    // Draft with the agent: the reply opens in the composer as tracked changes and is saved, not sent.
    fireEvent.click(screen.getByRole("button", { name: "Mail agent" }));
    const draftButton = await screen.findByRole("button", { name: "Draft a reply" });
    await act(async () => {
      fireEvent.click(draftButton);
    });
    const composer = await screen.findByRole("region", { name: "Reply" }, { timeout: 4000 });
    const editor = within(composer).getByRole("textbox", { name: "Message" });
    await waitFor(() => expect(editor.querySelector("ins.redline-ins")?.textContent).toContain("Thursday works for me"));
    expect(within(composer).getByRole("toolbar", { name: "Review changes" })).toBeTruthy();
    const prompt = String(host.ai.generate.mock.calls[0][0].prompt);
    expect(prompt).toContain("Thursday works");
    await waitFor(() => expect(host.bridge.callsTo("create_reply_draft")).toHaveLength(1));
    const created = host.bridge.callsTo("create_reply_draft")[0].params;
    expect(created).toMatchObject({ threadId: "18c1a", inReplyTo: "<bob-2@mail.example.com>" });
    expect(String(created.bodyText)).toContain("Thursday works for me");
    expect(sends()).toHaveLength(0);

    // Sending with an unreviewed change asks first; Cancel sends nothing.
    fireEvent.click(within(composer).getByRole("button", { name: "Send" }));
    const warning = await screen.findByRole("alertdialog");
    fireEvent.click(within(warning).getByRole("button", { name: "Cancel" }));
    expect(sends()).toHaveLength(0);

    // Accept the agent's text, then the owner's click sends exactly once.
    fireEvent.click(within(within(composer).getByRole("toolbar", { name: "Review changes" })).getByRole("button", { name: /Accept all/ }));
    await waitFor(() => expect(editor.querySelector("ins.redline-ins")).toBeNull());
    expect(editor.textContent).toContain("I will bring the Q3 numbers.");
    await act(async () => {
      fireEvent.click(within(composer).getByRole("button", { name: "Send" }));
    });
    await waitFor(() => expect(sends()).toHaveLength(1));
    expect(sends()[0].params).toEqual({ draftId: "r-900" });
    const saved = host.bridge.callsTo("update_draft").at(-1)?.params;
    expect(String(saved?.bodyText)).toContain(AGENT_REPLY.split("\n")[2]);
    expect(String(saved?.bodyHtml)).not.toContain("<ins");
    await waitFor(() => expect(screen.queryByRole("region", { name: "Reply" })).toBeNull());
    expect(await screen.findByText("Message sent")).toBeTruthy();
  });

  it("searches every account, files Gmail and Outlook conversations, and saves a spreadsheet attachment to Files", async () => {
    await mountApp();

    // Search: Enter asks both providers; the results replace the inbox list.
    const search = screen.getByRole("searchbox", { name: "Search mail" });
    fireEvent.change(search, { target: { value: "budget" } });
    await act(async () => {
      fireEvent.keyDown(search, { key: "Enter" });
    });
    await waitFor(() => expect(row("Receipt")).toBeTruthy());
    await waitFor(() => expect(row("Invoice 42")).toBeTruthy());
    expect(row("Lunch?")).toBeUndefined();
    expect(host.bridge.callsTo("list_threads_query").some((call) => call.params.query === "budget")).toBe(true);
    expect(host.bridge.callsTo("search_messages").some((call) => call.params.query === "budget")).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    });
    await waitFor(() => expect(row("Review – Q3")).toBeTruthy());

    // File on Gmail: archive removes the INBOX label from every message of the thread.
    await act(async () => {
      fireEvent.click(row("Review – Q3")!);
    });
    await screen.findByRole("heading", { name: "Review – Q3" });
    await act(async () => {
      fireEvent.click(within(screen.getByRole("toolbar", { name: "Conversation actions" })).getByRole("button", { name: "Archive" }));
    });
    const archived = host.bridge.callsTo("batch_modify").find((call) => (call.params.removeLabelIds as string[] | undefined)?.includes("INBOX"));
    expect(archived?.params.messageIds).toEqual(expect.arrayContaining(["m-a1", "m-a2"]));
    await waitFor(() => expect(row("Review – Q3")).toBeUndefined());
    expect(screen.getByRole("status").textContent).toContain("Archived");

    // Read on Outlook: the remote tracking image is not loaded.
    const outlookRow = row("RE: Budget") ?? row("Budget");
    await act(async () => {
      fireEvent.click(outlookRow!);
    });
    const message = await screen.findByRole("article", { name: "Message from Grace Hopper" });
    const doc = frameDoc(message);
    expect(doc.body.textContent).toContain("Numbers attached & ready.");
    expect(doc.querySelector('img[src^="https://tracker.example"]')).toBeNull();

    // Attachment: the spreadsheet is saved into the owner's home byte for byte.
    const chip = await within(message).findByRole("button", { name: "Open budget.xlsx in Sheets" });
    await act(async () => {
      fireEvent.click(chip);
    });
    await waitFor(() => expect(host.home.files.has("Documents/Mail attachments/budget.xlsx")).toBe(true));
    expect(toBase64(host.home.files.get("Documents/Mail attachments/budget.xlsx")!.bytes)).toBe(toBase64(XLSX_BYTES));
    expect(await screen.findByText(/Saved to Documents\/Mail attachments\/budget\.xlsx/)).toBeTruthy();

    // File on Outlook: archive moves the inbox message to the Archive folder and leaves Sent alone.
    await act(async () => {
      fireEvent.click(within(screen.getByRole("toolbar", { name: "Conversation actions" })).getByRole("button", { name: "Archive" }));
    });
    await waitFor(() => expect(host.bridge.callsTo("move_message")).toHaveLength(1));
    expect(host.bridge.callsTo("move_message")[0].params).toEqual({ messageId: "msg-a2", destinationFolderId: OUTLOOK_ARCHIVE_ID });
    await waitFor(() => expect(row("RE: Budget") ?? row("Budget")).toBeUndefined());
    expect(sends()).toHaveLength(0);
  });

  it("composes a new message with a spreadsheet from Files and keeps it as a draft until Send", async () => {
    await mountApp();
    fireEvent.click(screen.getByRole("button", { name: "New message" }));
    const composer = await screen.findByRole("region", { name: "New message" }, { timeout: 4000 });
    const to = within(composer).getByLabelText("To");
    fireEvent.change(to, { target: { value: "grace@contoso.com" } });
    fireEvent.blur(to);
    fireEvent.change(within(composer).getByLabelText("Subject"), { target: { value: "Budget sheet" } });
    const editor = within(composer).getByRole("textbox", { name: "Message" });
    act(() => {
      editor.innerHTML = "<div>Here is the sheet.</div>";
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });

    fireEvent.click(within(composer).getByRole("button", { name: /Attach/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Open folder Documents" }));
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Attach basic.xlsx" }));
    });
    await waitFor(() => expect(within(composer).getByText("basic.xlsx")).toBeTruthy());
    expect(host.home.api.stat).toHaveBeenCalledWith("Documents/basic.xlsx");

    // Closing keeps the draft at the provider, with the attachment bytes intact; nothing is sent.
    await act(async () => {
      fireEvent.click(within(composer).getByRole("button", { name: "Close draft" }));
    });
    await waitFor(() => expect(host.bridge.callsTo("create_html_draft").length + host.bridge.callsTo("update_draft").length).toBeGreaterThan(0));
    const saves = [...host.bridge.callsTo("create_html_draft"), ...host.bridge.callsTo("update_draft")];
    const last = saves.at(-1)!.params as { to: unknown; subject: string; attachments?: Array<{ filename: string; contentBase64: string }> };
    expect(last.subject).toBe("Budget sheet");
    expect(JSON.stringify(last.to)).toContain("grace@contoso.com");
    expect(last.attachments?.[0]).toMatchObject({ filename: "basic.xlsx", contentBase64: toBase64(XLSX_BYTES) });
    expect(sends()).toHaveLength(0);
    expect(screen.queryByRole("region", { name: "New message" })).toBeNull();
  });
});

describe("Mail app connection states", () => {
  it("shows onboarding when no mailbox is connected and finds one after the owner connects it", async () => {
    host = fakeHost({ connected: [] });
    host.install();
    render(<App />);
    expect(await screen.findByText("Connect your mail")).toBeTruthy();
    expect(screen.getByText(/Settings > Integrations/)).toBeTruthy();
    host.bridge.connected = [{ service: "gmail", account_label: "Personal", account_email: "owner@example.com", status: "active" }];
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "I have connected an account" }));
    });
    await waitFor(() => expect(row("Review – Q3")).toBeTruthy(), { timeout: 4000 });
  });

  it("explains that mail is unavailable on a host without integrations", async () => {
    render(<App />);
    expect(await screen.findByText("Mail accounts are not available here")).toBeTruthy();
  });
});
