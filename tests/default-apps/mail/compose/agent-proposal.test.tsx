// @vitest-environment jsdom
/**
 * An agent draft must open as tracked changes however the composer and the
 * agent race: the agent text can land in the draft before the composer mounts,
 * and the proposal can be recorded before or after the mount.
 */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import React, { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProposalRegistry, type DraftProposal, type ProposalRegistry } from "../../../../home/apps/mail/src/agent/proposals";
import { createMailStore, noMailCache, selectActiveDraft, threadKey, type MailStore } from "../../../../home/apps/mail/src/model";
import { useMailState } from "../../../../home/apps/mail/src/ui/use-mail-store";
import { Composer } from "../../../../home/apps/mail/src/ui/compose/Composer";
import { FakeProvider } from "../model/fake-provider";
import { GMAIL, GMAIL_FOLDERS, message, summary, thread } from "../model/fixtures";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const NOW = Date.parse("2026-11-20T10:00:00Z");
const AGENT_TEXT = "Hi Alice,\n\nThursday works for me.\n\nThanks";

function Host({ store, provider, proposals }: { store: MailStore; provider: FakeProvider; proposals: ProposalRegistry }) {
  const state = useMailState(store);
  const draft = selectActiveDraft(state);
  if (!draft || !draft.open) return <p>No composer</p>;
  return (
    <Composer
      key={draft.localId}
      store={store}
      state={state}
      draft={draft}
      entries={[{ account: GMAIL, provider }]}
      onClose={() => store.closeDraft(draft.localId)}
      bridge={{}}
      ai={null}
      proposals={proposals}
      now={() => NOW}
    />
  );
}

async function setup() {
  const provider = new FakeProvider(GMAIL_FOLDERS);
  provider.lists.INBOX = [summary("t1", { participants: [{ name: "Alice", address: "alice@example.com" }] })];
  provider.threads.t1 = thread("t1", [message("m1")]);
  const store = createMailStore({ accounts: [{ account: GMAIL, provider }], cache: noMailCache, now: () => NOW, timeZone: "UTC", autosaveMs: 10, logger: () => undefined });
  await store.start();
  return { provider, store, proposals: createProposalRegistry() };
}

/** What the agent does: open a reply and write its text into it. */
async function agentWrites(store: MailStore): Promise<string> {
  const localId = (await store.respond("reply", { key: threadKey(GMAIL.id, "t1") }))!;
  store.editDraft(localId, { bodyText: AGENT_TEXT, bodyHtml: `<div>${AGENT_TEXT.replace(/\n/g, "<br>")}</div>` });
  return localId;
}

function proposalFor(localId: string): DraftProposal {
  return {
    id: "proposal-1", draftLocalId: localId, kind: "reply", accountId: GMAIL.id, threadKey: threadKey(GMAIL.id, "t1"),
    subject: "Re: Subject t1", to: ["alice@example.com"], original: "", proposed: AGENT_TEXT, instruction: "",
    status: "proposed", saveFailed: false, createdAt: NOW,
  };
}

const editor = () => screen.getByRole("textbox", { name: "Message" });

describe("agent draft as tracked changes", () => {
  it("shows the agent text as an insertion when the proposal is recorded after the composer opened with that text", async () => {
    const { provider, store, proposals } = await setup();
    let localId = "";
    await act(async () => {
      localId = await agentWrites(store);
    });
    render(<StrictMode><Host store={store} provider={provider} proposals={proposals} /></StrictMode>);
    expect(editor().textContent).toContain("Thursday works for me.");
    act(() => {
      proposals.add(proposalFor(localId));
    });
    await waitFor(() => expect(editor().querySelector("ins.redline-ins")?.textContent).toContain("Thursday works for me."));
    expect(screen.getByRole("toolbar", { name: "Review changes" })).toBeTruthy();
    expect(proposals.get("proposal-1")?.status).toBe("proposed");
  });

  it("shows the redline when the proposal already exists as the composer opens", async () => {
    const { provider, store, proposals } = await setup();
    await act(async () => {
      proposals.add(proposalFor(await agentWrites(store)));
    });
    render(<StrictMode><Host store={store} provider={provider} proposals={proposals} /></StrictMode>);
    await waitFor(() => expect(editor().querySelector("ins.redline-ins")?.textContent).toContain("Thursday works for me."));
  });

  it("leaves the owner's edits alone when the proposal arrives after the owner changed the text", async () => {
    const { provider, store, proposals } = await setup();
    let localId = "";
    await act(async () => {
      localId = await agentWrites(store);
    });
    render(<Host store={store} provider={provider} proposals={proposals} />);
    act(() => {
      editor().innerHTML = "<div>Owner wrote this instead</div>";
      editor().dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      proposals.add(proposalFor(localId));
    });
    expect(editor().querySelector("ins.redline-ins")).toBeNull();
    expect(editor().textContent).toContain("Owner wrote this instead");
  });
});
