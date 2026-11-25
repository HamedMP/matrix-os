// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MailAgentPanel } from "../../../../home/apps/mail/src/ui/agent";
import { createMailAgent } from "../../../../home/apps/mail/src/agent/controller";
import { threadKey } from "../../../../home/apps/mail/src/model/ids";
import { GMAIL, message, summary, thread } from "../model/fixtures";
import { harness } from "./helpers";

afterEach(cleanup);

const k = (id: string) => threadKey(GMAIL.id, id);

async function setup() {
  const h = await harness((gmail) => {
    gmail.lists.INBOX = [summary("t1", { subject: "Thursday?" })];
    gmail.threads.t1 = thread("t1", [message("m1", { subject: "Thursday?", bodyText: "Can we meet Thursday? <script>alert(1)</script>" })]);
  });
  await h.store.openThread(k("t1"));
  return { ...h, agent: createMailAgent(h.ctx) };
}

describe("MailAgentPanel", () => {
  it("drafts a reply from the quick action and shows it for review as text", async () => {
    const { agent, store, ai, gmail } = await setup();
    ai.fallback = '{"body":"Thursday works <b>great</b>."}';
    const onShowComposer = vi.fn();
    render(<MailAgentPanel agent={agent} store={store} onShowComposer={onShowComposer} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Draft a reply" }));
    });
    await screen.findByText("Reply draft: Re: Thursday?");
    expect(screen.getByText("Thursday works <b>great</b>.")).toBeTruthy();
    expect(document.querySelector("b")).toBeNull();
    expect(onShowComposer).toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    });
    expect(screen.getByText("Rejected")).toBeTruthy();
    expect(gmail.calls.deleteDraft).toHaveLength(1);
    expect(gmail.calls.sendDraft).toHaveLength(0);
  });

  it("explains when the host has no assistant", async () => {
    const { store } = await setup();
    render(<MailAgentPanel agent={null} store={store} />);
    expect(screen.getByText(/not available here/)).toBeTruthy();
  });

  it("runs bulk drafts end to end and sends only after ConfirmSend", async () => {
    const { agent, store, ai, gmail } = await setup();
    ai.fallback = (prompt: string) => `{"subject":"Launch","body":"Hi ${/Name: (\w+)/.exec(prompt)?.[1] ?? "there"}"}`;
    render(<MailAgentPanel agent={agent} store={store} />);
    fireEvent.click(screen.getByRole("button", { name: "Bulk drafts…" }));
    const dialog = await screen.findByRole("dialog", { name: "Bulk drafts" });
    fireEvent.change(within(dialog).getByLabelText("Rows"), { target: { value: "Name\tEmail\nAda\tada@example.com\nBo\tbo@example.com" } });
    fireEvent.change(within(dialog).getByLabelText("Instruction"), { target: { value: "Invite them" } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Write 2 drafts" }));
    });
    await waitFor(() => expect(within(dialog).getAllByText("Ready")).toHaveLength(2));

    fireEvent.click(within(dialog).getByLabelText("Row 2: bo@example.com"));
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Create drafts" }));
    });
    await waitFor(() => expect(within(dialog).getByText("Draft saved")).toBeTruthy());
    expect(gmail.calls.saveDraft.map((d) => d.to[0].address)).toEqual(["ada@example.com"]);
    expect(gmail.calls.sendDraft).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole("button", { name: "Send selected…" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(within(confirm).getByText("ada@example.com")).toBeTruthy();
    expect(gmail.calls.sendDraft).toHaveLength(0);
    await act(async () => {
      fireEvent.click(within(confirm).getByRole("button", { name: "Send 1" }));
    });
    await waitFor(() => expect(gmail.calls.sendDraft).toEqual(["draft-1"]));
    await waitFor(() => expect(screen.getByText("Sent")).toBeTruthy());
  });
});
