// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "../../../../home/apps/_shared/office-accounts/types/mail";
import { createMailStore, noMailCache, selectActiveDraft, threadKey, type MailStore } from "../../../../home/apps/mail/src/model";
import { useMailState } from "../../../../home/apps/mail/src/ui/use-mail-store";
import { Composer, type ComposeBridge } from "../../../../home/apps/mail/src/ui/compose/Composer";
import { forget } from "../../../../home/apps/mail/src/compose/sessions";
import { hasTrackedMarkup } from "../../../../home/apps/mail/src/compose/redline-body";
import { SIGNATURE_KEY } from "../../../../home/apps/mail/src/compose/signature";
import { FakeProvider } from "../model/fake-provider";
import { GMAIL, GMAIL_FOLDERS, message, summary, thread } from "../model/fixtures";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const NOW = Date.parse("2026-11-20T10:00:00Z");

function Host({ store, bridge, ai }: { store: MailStore; bridge: ComposeBridge; ai: { generate: (prompt: string) => Promise<string> } | null }) {
  const state = useMailState(store);
  const draft = selectActiveDraft(state);
  if (!draft || !draft.open) return <p>No composer</p>;
  return (
    <Composer
      key={draft.localId}
      store={store}
      state={state}
      draft={draft}
      entries={[{ account: GMAIL, provider: provider! }]}
      onClose={() => store.closeDraft(draft.localId)}
      bridge={bridge}
      ai={ai}
      now={() => NOW}
    />
  );
}

let provider: FakeProvider | null = null;

async function setup(options: { ai?: { generate: (prompt: string) => Promise<string> } | null; bridge?: ComposeBridge } = {}) {
  provider = new FakeProvider(GMAIL_FOLDERS);
  provider.lists.INBOX = [summary("t1", { participants: [{ name: "Alice", address: "alice@example.com" }, { name: "Bob Jones", address: "bob@example.com" }] })];
  provider.threads.t1 = thread("t1", [message("m1")]);
  const store = createMailStore({ accounts: [{ account: GMAIL, provider }], cache: noMailCache, now: () => NOW, timeZone: "UTC", autosaveMs: 10, logger: () => undefined });
  await store.start();
  const bridge = options.bridge ?? {};
  const view = render(<Host store={store} bridge={bridge} ai={options.ai ?? null} />);
  return { store, provider, view, bridge };
}

function editor(): HTMLElement {
  return screen.getByRole("textbox", { name: "Message" });
}

/** What the browser does when the owner types: the DOM changes, then `input` fires. */
function typeInto(html: string) {
  act(() => {
    editor().innerHTML = html;
    editor().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function draftOf(store: MailStore) {
  const state = store.getSnapshot();
  return state.activeDraftId ? state.drafts[state.activeDraftId] : Object.values(state.drafts)[0];
}

async function addRecipient(text: string) {
  const to = screen.getByLabelText("To");
  fireEvent.change(to, { target: { value: text } });
  fireEvent.blur(to);
}

describe("sending", () => {
  it("never sends from typing or autosave; Send sends once, after the draft is saved", async () => {
    const { store, provider } = await setup();
    act(() => {
      store.compose();
    });
    await addRecipient("alice@example.com");
    typeInto("<div>Hello Alice</div>");
    await waitFor(() => expect(provider.calls.saveDraft.length).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(provider.calls.sendDraft).toEqual([]);
    expect(provider.calls.saveDraft.at(-1)?.bodyHtml).toBe("<div>Hello Alice</div>");

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(provider.calls.sendDraft).toHaveLength(1));
    expect(provider.calls.sendDraft[0]).toBe(provider.calls.saveDraft.at(-1)?.id ?? "draft-1");
    await waitFor(() => expect(screen.getByText("No composer")).toBeTruthy());
  });

  it("keeps the draft open with a safe error when sending fails", async () => {
    const { store, provider } = await setup();
    provider.onSendDraft = async () => {
      throw new ProviderError("failed");
    };
    act(() => {
      store.compose();
    });
    await addRecipient("alice@example.com");
    typeInto("<div>Hi</div>");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(provider.calls.sendDraft).toHaveLength(1));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Something went wrong. Try again.");
    expect(alert.textContent).toBe(draftOf(store).error?.message);
    expect(screen.getByRole("textbox", { name: "Message" })).toBeTruthy();
    expect(draftOf(store).sending).toBe(false);
  });

  it("blocks Send while a recipient is not a valid address", async () => {
    const { store, provider } = await setup();
    act(() => {
      store.compose();
    });
    await addRecipient("alice@example.com, not-an-address");
    expect(screen.getByText("alice@example.com")).toBeTruthy();
    expect(screen.getByText("not-an-address")).toBeTruthy();
    typeInto("<div>Hi</div>");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Fix or remove the addresses marked in red.");
    expect(provider.calls.sendDraft).toEqual([]);
    expect(draftOf(store).draft.to).toEqual([{ address: "alice@example.com" }]);
  });

  it("suggests recipients seen in the cache", async () => {
    const { store } = await setup();
    act(() => {
      store.compose();
    });
    const to = screen.getByLabelText("To");
    fireEvent.change(to, { target: { value: "bo" } });
    const option = await screen.findByRole("option", { name: /bob@example.com/ });
    fireEvent.mouseDown(option);
    expect(draftOf(store).draft.to).toEqual([{ name: "Bob Jones", address: "bob@example.com" }]);
  });
});

describe("tracked changes", () => {
  const ai = (text: string) => ({ generate: vi.fn(async () => JSON.stringify({ body: text })) });

  it("opens an assistant rewrite as a redline and warns at Send with the count of unresolved changes", async () => {
    const model = ai("Hello Alice,\nThursday works for me.");
    const { store, provider } = await setup({ ai: model });
    act(() => {
      store.compose();
    });
    await addRecipient("alice@example.com");
    typeInto("<div>Hello Alice,</div><div>Monday works for me.</div>");
    fireEvent.click(screen.getByRole("button", { name: "Rewrite" }));
    fireEvent.change(await screen.findByLabelText("How should it change?"), { target: { value: "Use Thursday" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask assistant" }));
    const review = await screen.findByRole("toolbar", { name: "Review changes" });
    expect(model.generate).toHaveBeenCalledTimes(1);
    expect(within(review).getByText(/1 of \d+/)).toBeTruthy();
    expect(editor().querySelector("ins.redline-ins")).toBeTruthy();
    expect(editor().querySelector("del.redline-del")?.getAttribute("contenteditable")).toBe("false");
    await waitFor(() => expect(hasTrackedMarkup(provider.calls.saveDraft.at(-1)?.bodyHtml ?? "")).toBe(true));
    const pending = review.textContent!.match(/of (\d+)/)![1];

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    const warning = await screen.findByRole("alertdialog");
    expect(warning.textContent).toContain(`${pending} tracked change`);
    fireEvent.click(within(warning).getByRole("button", { name: "Cancel" }));
    expect(provider.calls.sendDraft).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Accept all and send" }));
    await waitFor(() => expect(provider.calls.sendDraft).toHaveLength(1));
    const sent = provider.calls.saveDraft.at(-1)!;
    expect(hasTrackedMarkup(sent.bodyHtml)).toBe(false);
    expect(sent.bodyText).toBe("Hello Alice,\nThursday works for me.");
  });

  it("steps, accepts and rejects one change at a time while the owner keeps typing", async () => {
    const { store } = await setup({ ai: ai("one two three") });
    act(() => {
      store.compose();
    });
    typeInto("<div>one 2 three</div>");
    fireEvent.click(screen.getByRole("button", { name: "Rewrite" }));
    fireEvent.click(await screen.findByRole("button", { name: "Ask assistant" }));
    const review = await screen.findByRole("toolbar", { name: "Review changes" });
    const total = Number(review.textContent!.match(/of (\d+)/)![1]);
    expect(total).toBeGreaterThan(1);
    fireEvent.click(within(review).getByRole("button", { name: "Reject change" }));
    await waitFor(() => expect(Number(review.textContent!.match(/of (\d+)/)?.[1] ?? 1)).toBeLessThan(total));
    typeInto(`${editor().innerHTML.replace(/<del[^>]*>.*?<\/del>/g, "")}<div>more</div>`);
    expect(draftOf(store).draft.bodyText).toContain("more");
    fireEvent.click(within(screen.getByRole("toolbar", { name: "Review changes" })).getByRole("button", { name: /Accept all/ }));
    expect(screen.queryByRole("toolbar", { name: "Review changes" })).toBeNull();
    expect(hasTrackedMarkup(draftOf(store).draft.bodyHtml)).toBe(false);
  });

  it("Suggest edits turns the owner's typing into tracked changes that survive reopening the draft", async () => {
    const { store, view } = await setup();
    act(() => {
      store.compose();
    });
    typeInto("<div>We ship on Friday.</div>");
    fireEvent.click(screen.getByRole("button", { name: "Suggest edits" }));
    typeInto("<div>We ship on Monday.</div>");
    const review = await screen.findByRole("toolbar", { name: "Review changes" });
    expect(review.textContent).toContain("of 2");
    const draft = draftOf(store);
    expect(draft.draft.bodyText).toBe("We ship on [-Friday-]{+Monday+}.");

    // Reopen from the stored body alone: drop the live session and mount a fresh composer.
    view.unmount();
    forget(draft.localId);
    render(<Host store={store} bridge={{}} ai={null} />);
    const reopened = await screen.findByRole("toolbar", { name: "Review changes" });
    expect(reopened.textContent).toContain("1 of 2");
    expect(editor().querySelector("del")?.textContent).toBe("Friday");
  });
});

describe("drafting", () => {
  it("asks before discarding", async () => {
    const { store } = await setup();
    act(() => {
      store.compose();
    });
    typeInto("<div>Draft</div>");
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    expect(Object.keys(store.getSnapshot().drafts)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(Object.keys(store.getSnapshot().drafts)).toHaveLength(0));
  });

  it("inserts the account's signature into a new draft and shows the quoted original collapsed", async () => {
    const data: Record<string, unknown> = { [SIGNATURE_KEY]: { [GMAIL.id]: "Me\nMatrix" } };
    const bridge: ComposeBridge = { readData: async (key) => data[key] ?? null, writeData: async (key, value) => { data[key] = value; } };
    const { store } = await setup({ bridge });
    await act(async () => {
      await store.respond("reply", { key: threadKey(GMAIL.id, "t1") });
    });
    await waitFor(() => expect(draftOf(store).draft.bodyText).toContain("Matrix"));
    expect(screen.queryByLabelText("Quoted message")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show quoted text" }));
    expect(screen.getByLabelText("Quoted message").textContent).toContain("Alice");
  });

  it("attaches a file from the owner's home after checking its size", async () => {
    const bytes = new TextEncoder().encode("report");
    const files = {
      list: vi.fn(async (dir: string) => ({
        entries: dir === ""
          ? [{ name: "Documents", path: "Documents", kind: "dir" as const, size: 0, modifiedAt: "" }]
          : [{ name: "Report.docx", path: "Documents/Report.docx", kind: "file" as const, size: bytes.length, modifiedAt: "" }],
        truncated: false,
      })),
      stat: vi.fn(async (path: string) => ({ path, size: bytes.length, modifiedAt: "", version: "1" })),
      read: vi.fn(async (path: string) => ({ path, bytes, size: bytes.length, version: "1", mimeType: "" })),
    };
    const { store } = await setup({ bridge: { files } });
    act(() => {
      store.compose();
    });
    fireEvent.click(screen.getByRole("button", { name: /Attach/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Open folder Documents" }));
    expect((await screen.findByRole("button", { name: "Attach Report.docx" })).textContent).toContain("Docs document");
    fireEvent.click(screen.getByRole("button", { name: "Attach Report.docx" }));
    await waitFor(() => expect(draftOf(store).draft.attachments).toHaveLength(1));
    expect(draftOf(store).draft.attachments[0]).toMatchObject({ name: "Report.docx", size: 6, contentBase64: "cmVwb3J0" });
    expect(files.stat).toHaveBeenCalledBefore(files.read);
  });
});
