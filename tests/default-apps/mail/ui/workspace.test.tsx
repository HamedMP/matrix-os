// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "../../../../home/apps/_shared/office-accounts/types/mail";
import { page, summary } from "../model/fixtures";
import { dataTransfer, renderWorkspace } from "./harness";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const rows = () => screen.getAllByRole("row");
const row = (subject: string) => rows().find((el) => within(el).queryByText(subject))!;

describe("thread list", () => {
  it("renders sender, subject, snippet, time and the unread, flag and attachment indicators as text", async () => {
    await renderWorkspace([
      summary("t1", {
        subject: "<img src=x onerror=alert(1)>Budget",
        snippet: "Numbers attached",
        unread: true,
        flagged: true,
        hasAttachments: true,
        participants: [{ name: "Alice Smith", address: "alice@example.com" }],
        lastMessageAt: "2026-11-10T09:05:00Z",
      }),
      summary("t2", { subject: "Lunch", lastMessageAt: "2026-11-09T09:00:00Z" }),
    ]);
    const first = row("<img src=x onerror=alert(1)>Budget");
    expect(within(first).getByText("Alice Smith")).toBeTruthy();
    expect(within(first).getByText("Numbers attached")).toBeTruthy();
    expect(within(first).getByText("09:05")).toBeTruthy();
    expect(within(first).getByLabelText("Unread")).toBeTruthy();
    expect(within(first).getByLabelText("Flagged")).toBeTruthy();
    expect(within(first).getByLabelText("Has attachments")).toBeTruthy();
    expect(first.querySelector("img")).toBeNull();
    expect(within(row("Lunch")).queryByLabelText("Unread")).toBeNull();
  });

  it("renders only the rows in view and loads the next page near the end", async () => {
    const { provider } = await renderWorkspace(page("t", 200));
    expect(screen.getByText("50 conversations")).toBeTruthy();
    expect(rows().length).toBeLessThan(40);
    const list = screen.getByRole("grid", { name: "Conversations" });
    await act(async () => {
      list.scrollTop = 50 * 72 - 600;
      fireEvent.scroll(list);
    });
    await waitFor(() => expect(screen.getByText("100 conversations")).toBeTruthy());
    expect(provider.calls.listThreads.at(-1)?.cursor).toBe("50");
    expect(screen.getByText("Subject t49")).toBeTruthy();
  });

  it("selects with checkboxes and shift-click and runs bulk archive with an undo toast", async () => {
    const { provider } = await renderWorkspace(page("t", 5));
    fireEvent.click(within(row("Subject t0")).getByRole("checkbox"));
    fireEvent.click(within(row("Subject t2")).getByRole("checkbox"), { shiftKey: true });
    expect(within(screen.getByRole("toolbar", { name: "Bulk actions" })).getByText("3 selected")).toBeTruthy();
    expect(rows().filter((el) => el.getAttribute("aria-selected") === "true")).toHaveLength(3);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Archive selected" }));
    });
    expect(provider.calls.modifyThreads).toEqual([{ ids: ["t0", "t1", "t2"], change: { removeFolders: ["INBOX"] } }]);
    expect(screen.queryByText("Subject t1")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Archived 3 conversations");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    });
    expect(provider.calls.modifyThreads[1]).toEqual({ ids: ["t0", "t1", "t2"], change: { addFolders: ["INBOX"] } });
    await waitFor(() => expect(screen.getByText("Subject t1")).toBeTruthy());
  });

  it("marks the selection read and flags it from the bulk bar", async () => {
    const { provider } = await renderWorkspace([summary("t1", { unread: true }), summary("t2")]);
    fireEvent.click(within(row("Subject t1")).getByRole("checkbox"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Mark selected as read" }));
    });
    expect(provider.calls.modifyThreads.at(-1)).toEqual({ ids: ["t1"], change: { read: true } });
    fireEvent.click(within(row("Subject t2")).getByRole("checkbox"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Flag selected" }));
    });
    expect(provider.calls.modifyThreads.at(-1)).toEqual({ ids: ["t2"], change: { flagged: true } });
  });
});

describe("keyboard triage", () => {
  it("moves with j and k, archives with e and opens the shortcut sheet with ?", async () => {
    const { provider, store } = await renderWorkspace(page("t", 3));
    fireEvent.keyDown(document.body, { key: "j" });
    fireEvent.keyDown(document.body, { key: "j" });
    await waitFor(() => expect(row("Subject t1").className).toContain("is-focused"));
    fireEvent.keyDown(document.body, { key: "k" });
    await waitFor(() => expect(store.getSnapshot().focused).toContain("t0"));

    await act(async () => {
      fireEvent.keyDown(document.body, { key: "e" });
    });
    expect(provider.calls.modifyThreads).toEqual([{ ids: ["t0"], change: { removeFolders: ["INBOX"] } }]);
    expect(screen.queryByText("Subject t0")).toBeNull();

    fireEvent.keyDown(document.body, { key: "?" });
    const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    expect(within(dialog).getByText("Archive")).toBeTruthy();
    expect(within(dialog).getByText("Mark as unread")).toBeTruthy();
  });

  it("ignores mail keys typed into the search box and focuses search with /", async () => {
    const { provider } = await renderWorkspace(page("t", 2));
    const search = screen.getByRole("searchbox", { name: "Search mail" });
    fireEvent.keyDown(document.body, { key: "/" });
    await waitFor(() => expect(document.activeElement).toBe(search));
    fireEvent.keyDown(search, { key: "e" });
    expect(provider.calls.modifyThreads).toHaveLength(0);
  });
});

describe("per-pane errors", () => {
  it("shows a list error with a retry that reloads the list", async () => {
    let fail = true;
    const { provider } = await renderWorkspace(page("t", 2), (p) => {
      p.onListThreads = async (request) => {
        if (fail) throw new ProviderError("failed");
        return { items: p.lists[request.folderId] ?? [], nextCursor: null };
      };
    });
    expect(await screen.findByText("Conversations could not be loaded")).toBeTruthy();
    expect(document.body.textContent).not.toContain("/internal");
    fail = false;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    });
    expect(await screen.findByText("Subject t0")).toBeTruthy();
    expect(provider.calls.listThreads.length).toBeGreaterThanOrEqual(2);
  });

  it("shows a reading-pane error with retry when a conversation cannot be opened", async () => {
    await renderWorkspace(page("t", 1), (p) => {
      p.onGetThread = async () => {
        throw new ProviderError("rate_limited");
      };
    });
    await act(async () => {
      fireEvent.click(row("Subject t0"));
    });
    expect(await screen.findByText("This conversation could not be opened")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});

describe("drag to file", () => {
  it("moves the dragged selection onto a folder", async () => {
    const { provider } = await renderWorkspace(page("t", 3));
    fireEvent.click(within(row("Subject t0")).getByRole("checkbox"));
    fireEvent.click(within(row("Subject t1")).getByRole("checkbox"));
    const transfer = dataTransfer();
    fireEvent.dragStart(row("Subject t1"), { dataTransfer: transfer });
    const projects = screen.getByRole("button", { name: /Projects/ });
    fireEvent.dragOver(projects, { dataTransfer: transfer });
    expect(projects.className).toContain("is-drop-target");
    await act(async () => {
      fireEvent.drop(projects, { dataTransfer: transfer });
    });
    expect(provider.calls.modifyThreads).toEqual([{ ids: ["t0", "t1"], change: { addFolders: ["Label_1"], removeFolders: ["INBOX"] } }]);
  });

  it("does not accept a drop on the drafts folder", async () => {
    const { provider } = await renderWorkspace(page("t", 1));
    const transfer = dataTransfer();
    fireEvent.dragStart(row("Subject t0"), { dataTransfer: transfer });
    const drafts = screen.getByRole("button", { name: /Drafts/ });
    fireEvent.dragOver(drafts, { dataTransfer: transfer });
    expect(drafts.className).not.toContain("is-drop-target");
    fireEvent.drop(drafts, { dataTransfer: transfer });
    expect(provider.calls.modifyThreads).toHaveLength(0);
  });
});
