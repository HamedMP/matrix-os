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
import Edition from "../../home/app-templates/connected-starter/src/edition/Edition";
import type { EditionMessage } from "../../home/app-templates/connected-starter/src/edition/types";
const source = {
  id: "s1",
  connectionId: "c1",
  email: "reader@example.test",
  label: "Reading",
  scope: "personal",
  state: "ready",
};
const article: EditionMessage = {
  id: "m1",
  sourceId: "s1",
  subject: "The art of noticing",
  sender: "The Observers",
  publication: "The Observers",
  receivedAt: "2026-10-06T09:00:00Z",
  excerpt: "A slower kind of attention.",
  text: "<script>danger()</script>\nA slower kind of attention.",
  contentVersion: "v1",
  classification: "newsletter",
  saved: false,
  read: false,
  progress: 0,
  revision: 1,
  readingRevision: 3,
};
function mockMail() {
  return vi.fn(async (action: string, payload: any) => {
    if (action === "cleanup-recovery") return {operations:[]};
    if (action === "sources")
      return { sources: [source], cacheScope: "owner-computer-v1" };
    if (action === "messages") return { messages: [article] };
    if (action === "message") return article;
    if (action === "reading")
      return { ...article, ...payload, revision: 2, readingRevision: 2 };
    if (action === "cleanup-preview")
      return {
        id: "plan",
        revision: 1,
        readingRevision: 1,
        messageIds: ["m1"],
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      };
    if (action === "cleanup-commit")
      return { id: "op", state: "completed", archivedCount: 1 };
    if (action === "cleanup-undo")
      return { id: "op", state: "undone", restoredCount: 1 };
    return {};
  });
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete window.MatrixOS;
  localStorage.clear();
  history.replaceState(null, "", "/");
});
describe("Edition reader interactions", () => {
  it("opens stored mail as inert text and saves with the actual revision", async () => {
    const mail = mockMail();
    window.MatrixOS = { mail };
    render(<Edition />);
    fireEvent.click(
      await screen.findByRole("button", { name: /Read The art of noticing/ }),
    );
    await screen.findByRole("heading", { name: "The art of noticing" });
    expect(document.querySelector(".edition-reading script")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save edition" }));
    await waitFor(() =>
      expect(mail).toHaveBeenCalledWith("reading", {
        id: "m1",
        baseRevision: 3,
        saved: true,
      }),
    );
    expect(
      await screen.findByRole("button", { name: "Unsave edition" }),
    ).toBeTruthy();
  });
  it("retains reading state when a save fails and hides raw transport failures", async () => {
    const mail = mockMail();
    mail.mockImplementation(async (action, payload) => {
      if (action === "reading") throw new Error("/home/private/db password");
      if (action === "cleanup-recovery") return {operations:[]};
    if (action === "sources")
        return { sources: [source], cacheScope: "owner-computer-v1" };
      if (action === "messages") return { messages: [article] };
      return article;
    });
    window.MatrixOS = { mail };
    render(<Edition />);
    fireEvent.click(
      await screen.findByRole("button", { name: /Read The art/ }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Save edition" }),
    );
    expect((await screen.findByRole("alert")).textContent).not.toContain(
      "/home",
    );
    expect(screen.getByRole("button", { name: "Save edition" })).toBeTruthy();
  });
  it("updates the visible progress after the server confirms Mark as read", async () => {
    window.MatrixOS = { mail: mockMail() };
    render(<Edition />);
    fireEvent.click(
      await screen.findByRole("button", { name: /Read The art of noticing/ }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Mark as read" }),
    );
    await screen.findByRole("button", { name: "Mark unread" });
    await waitFor(() =>
      expect(
        (
          screen.getByRole("slider", {
            name: "Reading progress",
          }) as HTMLInputElement
        ).value,
      ).toBe("100"),
    );
  });
  it("does not archive before exact preview approval, and offers confirmed undo", async () => {
    const mail = mockMail();
    window.MatrixOS = { mail };
    render(<Edition />);
    fireEvent.click(
      await screen.findByRole("checkbox", {
        name: "Select The art of noticing for inbox cleanup",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Review inbox cleanup" }),
    );
    await screen.findByRole("dialog", { name: "Review inbox cleanup" });
    expect(mail.mock.calls.some((c) => c[0] === "cleanup-commit")).toBe(false);
    fireEvent.click(
      screen.getByRole("button", { name: "Archive 1 selected newsletter" }),
    );
    await waitFor(() =>
      expect(mail).toHaveBeenCalledWith("cleanup-commit", {
        planId: "plan",
        revision: 1,
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Undo inbox archive" }),
    );
    await waitFor(() =>
      expect(mail).toHaveBeenCalledWith("cleanup-undo", { operationId: "op" }),
    );
    await screen.findByText("1 newsletters restored to your inbox.");
  });
  it("shows an honest empty connection state without populated demo mail", async () => {
    render(<Edition />);
    expect(await screen.findByText(/Open Edition in Matrix/)).toBeTruthy();
    expect(screen.queryByText("The art of noticing")).toBeNull();
  });
  it("preview mode labels fictional content and never calls the live bridge", async () => {
    history.replaceState(null, "", "/?preview");
    const mail = mockMail();
    window.MatrixOS = { mail };
    render(<Edition />);
    await screen.findByText("Fictional preview · no email changes");
    expect(mail).not.toHaveBeenCalled();
  });
});
it("does not reveal late article content after the runtime revokes its reading session", async () => {
  const mail = mockMail();
  let resolve!: (value: unknown) => void;
  const original = mail.getMockImplementation()!;
  mail.mockImplementation(async (action, payload) =>
    action === "message"
      ? new Promise((r) => {
          resolve = r;
        })
      : original(action, payload),
  );
  window.MatrixOS = { mail };
  render(<Edition />);
  fireEvent.click(
    await screen.findByRole("button", { name: /Read The art of noticing/ }),
  );
  await waitFor(() => expect(resolve).toBeTruthy());
  act(() => window.dispatchEvent(new Event("matrix-mail-cache-scope-changed")));
  await act(async () => resolve(article));
  await waitFor(() =>
    expect(
      screen.queryByRole("heading", { name: "The art of noticing" }),
    ).toBeNull(),
  );
  expect(screen.queryByText("A slower kind of attention.")).toBeNull();
});
it("uses server collection filters so Review does not depend on the first page of Latest", async () => {
  const mail = mockMail();
  window.MatrixOS = { mail };
  render(<Edition />);
  await screen.findByRole("button", { name: /Read The art/ });
  fireEvent.click(screen.getByRole("button", { name: "Review" }));
  await waitFor(() =>
    expect(mail).toHaveBeenCalledWith("messages", {
      view: "review",
      scope: "all",
      query: "",
    }),
  );
});
it("opens the newest selection while an earlier article request is pending", async () => {
  const mail = mockMail(),
    original = mail.getMockImplementation()!;
  const next = { ...article, id: "m2", subject: "A second edition" };
  let finish!: (value: unknown) => void;
  mail.mockImplementation(async (action, payload) => {
    if (action === "messages") return { messages: [article, next] };
    if (action === "message")
      return payload.id === "m1"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : next;
    return original(action, payload);
  });
  window.MatrixOS = { mail };
  render(<Edition />);
  fireEvent.click(
    await screen.findByRole("button", { name: /Read The art of noticing/ }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: /Read A second edition/ }),
  );
  await screen.findByRole("heading", { name: "A second edition", level: 1 });
  await act(async () => finish(article));
  expect(
    screen.getByRole("heading", { name: "A second edition", level: 1 }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("heading", { name: "The art of noticing", level: 1 }),
  ).toBeNull();
});
