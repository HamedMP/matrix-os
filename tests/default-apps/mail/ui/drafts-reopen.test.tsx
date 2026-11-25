// @vitest-environment jsdom
/**
 * Drafts the owner closed can be opened again, and a stored provider draft can
 * be edited from the reading pane. Replying next to a saved draft answers the
 * last sent message, never the owner's own draft.
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderError, untrustedHtml } from "../../../../home/apps/_shared/office-accounts/types/mail";
import { message, summary, thread } from "../model/fixtures";
import { renderWorkspace } from "./harness";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const conversation = thread("t1", [
  message("m1", { from: { name: "Bob", address: "bob@example.com" }, to: [{ address: "me@example.com" }], subject: "Plans", bodyText: "Can you come?" }),
  message("d1", {
    from: { address: "me@example.com" }, to: [{ address: "someone@example.com" }], subject: "Re: Plans",
    bodyText: "My unsent words", bodyHtml: untrustedHtml('<p onclick="x()">My <b>unsent</b> words</p><script>x()</script><img src="https://t.example/p">'),
    draftId: "draft-9", sentAt: "2026-11-10T10:00:00Z",
  }),
]);

async function openConversation() {
  const harness = await renderWorkspace([summary("t1", { subject: "Plans", messageCount: 2 })], (p) => {
    p.threads.t1 = conversation;
  });
  await act(async () => {
    fireEvent.click(screen.getAllByRole("row")[0]);
  });
  await screen.findByRole("heading", { name: "Plans" });
  return harness;
}

describe("reopening drafts", () => {
  it("lists a closed draft whose save failed and opens it again", async () => {
    const { store, provider } = await renderWorkspace([summary("t1")]);
    provider.onSaveDraft = async () => { throw new ProviderError("failed"); };
    let id = "";
    await act(async () => {
      id = store.compose()!;
      store.editDraft(id, { subject: "Budget notes" });
    });
    await act(async () => {
      fireEvent.click(within(await screen.findByRole("region", { name: "New message" }, { timeout: 5000 })).getByRole("button", { name: "Close draft" }));
    });
    expect(screen.queryByRole("region", { name: "New message" })).toBeNull();
    const chip = await screen.findByRole("button", { name: /Open draft: Budget notes/ });
    await act(async () => {
      fireEvent.click(chip);
    });
    expect(await screen.findByRole("region", { name: "New message" })).toBeTruthy();
    expect(store.getSnapshot().activeDraftId).toBe(id);
  });

  it("offers Edit on a stored draft and opens it in the composer with its provider id", async () => {
    const { store, provider } = await openConversation();
    const draftCard = screen.getByRole("article", { name: "Message from me@example.com" });
    await act(async () => {
      fireEvent.click(within(draftCard).getByRole("button", { name: "Edit draft" }));
    });
    const composer = await screen.findByRole("region", { name: "Reply" });
    expect(composer).toBeTruthy();
    const active = store.getSnapshot().drafts[store.getSnapshot().activeDraftId!];
    expect(active.draft).toMatchObject({ id: "draft-9", inReplyToMessageId: "m1", to: [{ address: "someone@example.com" }] });
    expect(active.draft.bodyHtml).toContain("<b>unsent</b>");
    expect(active.draft.bodyHtml).not.toMatch(/script|onclick|<img/i);
    expect(provider.calls.saveDraft).toHaveLength(0);
  });
});

describe("replying next to a saved draft", () => {
  it("answers Bob's message, not the owner's unsent draft", async () => {
    const { store } = await openConversation();
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Reply" })[0]);
    });
    await waitFor(() => expect(store.getSnapshot().activeDraftId).not.toBeNull());
    const reply = store.getSnapshot().drafts[store.getSnapshot().activeDraftId!];
    expect(reply.draft).toMatchObject({ inReplyToMessageId: "m1", to: [{ name: "Bob", address: "bob@example.com" }] });
    expect(reply.quote?.text).toContain("Can you come?");
    expect(reply.quote?.text).not.toContain("My unsent words");
  });
});
