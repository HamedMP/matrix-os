// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatCollaboration } from "../../packages/ui/src/collaboration/ChatCollaboration";
import { CollaborationDirectError, type CollaborationContent } from "../../packages/ui/src/collaboration/direct-client";
import {
  SHARED_FILE_DOWNLOAD_MAX_BYTES,
  SHARED_FILE_EDIT_MAX_BYTES,
  SHARED_FILE_PREVIEW_MAX_BYTES,
  classifySharedFileFailure,
} from "../../packages/ui/src/collaboration/recipient-views";

const scopeId = "10000000-0000-4000-8000-000000000001";
const fileId = "20000000-0000-4000-8000-000000000001";
const base = `/api/collaboration/scopes/${scopeId}`;

function scope(role: "editor" | "viewer") {
  return {
    id: scopeId, ownerId: "user_owner", kind: "file", resourceId: fileId, membershipMode: "direct", lifecycle: "shared",
    revision: "1", authEpoch: "1", authorityGeneration: "1", role,
    capabilities: { read: true, discuss: true, manageMembers: false, requestAi: false, observeTerminal: false, controlTerminal: false, stopTerminal: false },
  };
}

function entry(revision: string, path = "notes/launch-notes.md") {
  return { id: fileId, kind: "file", path, parentId: null, revision, incarnation: "a".repeat(64), updatedAt: "2026-09-28T12:00:00.000Z" };
}

function text(value: string): CollaborationContent {
  const bytes = new TextEncoder().encode(value);
  return { status: "ok", bytes, contentType: "text/markdown", size: bytes.byteLength };
}

function unavailable(code: ConstructorParameters<typeof CollaborationDirectError>[0]): Error {
  return new Error("CollaborationUnavailable", { cause: new CollaborationDirectError(code) });
}

interface FakeHome {
  role: "editor" | "viewer";
  revision: string;
  body: CollaborationContent;
  entries?: unknown[];
  scopeFailure?: Error;
  listFailure?: Error;
  contentFailure?: Error;
  writeFailure?: Error;
}

function fakeApi(home: FakeHome) {
  const api = {
    baseUrl: "https://app.matrix-os.com",
    get: vi.fn(async (path: string) => {
      if (path === base) {
        if (home.scopeFailure) throw home.scopeFailure;
        return scope(home.role);
      }
      if (path.startsWith(`${base}/files?`)) {
        if (home.listFailure) throw home.listFailure;
        return { entries: home.entries ?? [entry(home.revision)] };
      }
      throw new Error(`unexpected ${path}`);
    }),
    getContent: vi.fn(async (path: string, options: { maxBytes: number }) => {
      expect(path).toBe(`${base}/files/${fileId}/content`);
      if (home.contentFailure) throw home.contentFailure;
      if (home.body.status === "ok" && home.body.size > options.maxBytes) return { status: "too_large" as const, size: home.body.size };
      return home.body;
    }),
    post: vi.fn(async (_path: string, body: { content: string; expectedRevision: string }) => {
      if (home.writeFailure) throw home.writeFailure;
      home.revision = String(Number(home.revision) + 1);
      home.body = text(body.content);
      return { entry: entry(home.revision), replayed: false };
    }),
    delete: vi.fn(),
  };
  return api;
}

let createObjectURL: ReturnType<typeof vi.fn>;
let clickedDownloads: Array<{ href: string; download: string }>;

beforeEach(() => {
  clickedDownloads = [];
  createObjectURL = vi.fn(() => "blob:matrix-download");
  Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    clickedDownloads.push({ href: this.href, download: this.download });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SharedFileView", () => {
  it("previews a text file for a Viewer without edit controls", async () => {
    const api = fakeApi({ role: "viewer", revision: "3", body: text("# Launch\nThursday review") });
    render(<ChatCollaboration view={{ kind: "file", scopeId }} api={api} actorId="user_ada" />);

    expect(await screen.findByRole("heading", { name: "launch-notes.md" })).toBeVisible();
    expect(screen.getByText("Viewer")).toBeVisible();
    expect(screen.getByLabelText("File preview")).toHaveTextContent("Thursday review");
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(api.getContent).toHaveBeenCalledWith(`${base}/files/${fileId}/content`, { maxBytes: SHARED_FILE_PREVIEW_MAX_BYTES });
    expect(api.get).toHaveBeenCalledWith(`${base}/files?limit=1`);
  });

  it("downloads the file under its own name", async () => {
    const api = fakeApi({ role: "viewer", revision: "3", body: text("hello") });
    render(<ChatCollaboration view={{ kind: "file", scopeId }} api={api} actorId="user_ada" />);

    fireEvent.click(await screen.findByRole("button", { name: "Download" }));

    await waitFor(() => expect(clickedDownloads).toEqual([{ href: "blob:matrix-download", download: "launch-notes.md" }]));
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
  });

  it("shows no preview for a file over the preview limit but still downloads it", async () => {
    const big = new Uint8Array(SHARED_FILE_PREVIEW_MAX_BYTES + 10).fill(65);
    const api = fakeApi({ role: "editor", revision: "3", body: { status: "ok", bytes: big, contentType: "text/plain", size: big.byteLength } });
    render(<ChatCollaboration view={{ kind: "file", scopeId }} api={api} actorId="user_ada" />);

    expect(await screen.findByText("This file is too large to preview. Download it to open it.")).toBeVisible();
    expect(screen.queryByLabelText("File preview")).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(clickedDownloads).toHaveLength(1));
    expect(api.getContent).toHaveBeenLastCalledWith(`${base}/files/${fileId}/content`, { maxBytes: SHARED_FILE_DOWNLOAD_MAX_BYTES });
  });

  it("explains a file too large to download here", async () => {
    const api = fakeApi({ role: "viewer", revision: "3", body: { status: "too_large", size: SHARED_FILE_DOWNLOAD_MAX_BYTES + 1 } });
    render(<ChatCollaboration view={{ kind: "file", scopeId }} api={api} actorId="user_ada" />);

    fireEvent.click(await screen.findByRole("button", { name: "Download" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("This file is too large to download here.");
    expect(clickedDownloads).toEqual([]);
  });

  it("offers binary files as download only", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a, 0x0a]);
    const api = fakeApi({ role: "editor", revision: "3", body: { status: "ok", bytes, contentType: "image/png", size: bytes.byteLength } });
    render(<ChatCollaboration view={{ kind: "file", scopeId }} api={api} actorId="user_ada" />);

    expect(await screen.findByText("No preview for this type of file. Download it to open it.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.getByRole("button", { name: "Download" })).toBeEnabled();
  });

  it("saves a Contributor edit against the revision it was based on", async () => {
    const api = fakeApi({ role: "editor", revision: "3", body: text("first draft") });
    render(<ChatCollaboration view={{ kind: "file", scopeId }} api={api} actorId="user_ada" />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "File contents" }), { target: { value: "second draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(api.post).toHaveBeenCalledOnce());
    expect(api.post).toHaveBeenCalledWith(`${base}/files/actions`, {
      type: "write", fileId, content: "second draft", expectedRevision: "3", clientRequestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(await screen.findByLabelText("File preview")).toHaveTextContent("second draft");
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
  });

  it("keeps the editor read-only while a save is in flight so no typing is lost", async () => {
    const home: FakeHome = { role: "editor", revision: "3", body: text("draft") };
    const api = fakeApi(home);
    let release!: () => void;
    const post = api.post;
    api.post = vi.fn(async (path: string, body: { content: string; expectedRevision: string }) => {
      await new Promise<void>((resolve) => { release = resolve; });
      return post(path, body);
    });
    render(<ChatCollaboration view={{ kind: "file", scopeId }} api={api} actorId="user_ada" />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "File contents" }), { target: { value: "sent text" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByRole("textbox", { name: "File contents" })).toHaveAttribute("readonly"));
    release();
    expect(await screen.findByLabelText("File preview")).toHaveTextContent("sent text");
  });

  it("stops a draft that grows past the inline edit limit and says why", async () => {
    const api = fakeApi({ role: "editor", revision: "3", body: text("short") });
    render(<ChatCollaboration view={{ kind: "file", scopeId }} api={api} actorId="user_ada" />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "File contents" }), { target: { value: "x".repeat(SHARED_FILE_EDIT_MAX_BYTES + 1) } });

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByText("This text is over the 64 KB limit for editing here. Shorten it to save.")).toBeVisible();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("treats text that is not valid UTF-8 as download-only and keeps its exact bytes", async () => {
    const bytes = new Uint8Array([0x68, 0x69, 0xff, 0xfe, 0x21]);
    const api = fakeApi({ role: "editor", revision: "3", body: { status: "ok", bytes, contentType: "text/plain", size: bytes.byteLength } });
    render(<ChatCollaboration view={{ kind: "file", scopeId }} api={api} actorId="user_ada" />);

    expect(await screen.findByText("No preview for this type of file. Download it to open it.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(clickedDownloads).toHaveLength(1));
    const saved = createObjectURL.mock.calls[0]![0] as Blob;
    expect(new Uint8Array(await saved.arrayBuffer())).toEqual(bytes);
  });

  it("downloads the exact bytes of a previewed text file", async () => {
    const bytes = new TextEncoder().encode("line one\r\nline two\n");
    const api = fakeApi({ role: "viewer", revision: "3", body: { status: "ok", bytes, contentType: "text/plain", size: bytes.byteLength } });
    render(<ChatCollaboration view={{ kind: "file", scopeId }} api={api} actorId="user_ada" />);

    fireEvent.click(await screen.findByRole("button", { name: "Download" }));
    await waitFor(() => expect(clickedDownloads).toHaveLength(1));
    const saved = createObjectURL.mock.calls[0]![0] as Blob;
    expect(Array.from(new Uint8Array(await saved.arrayBuffer()))).toEqual(Array.from(bytes));
  });

  it("does not offer editing for text files over the inline edit limit", async () => {
    const api = fakeApi({ role: "editor", revision: "3", body: text("x".repeat(SHARED_FILE_EDIT_MAX_BYTES + 1)) });
    render(<ChatCollaboration view={{ kind: "file", scopeId }} api={api} actorId="user_ada" />);

    expect(await screen.findByLabelText("File preview")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.getByText("This file is too large to edit here. Download it to edit it.")).toBeVisible();
  });

  it("keeps local text on a conflict, shows the owner's version and never overwrites", async () => {
    const home: FakeHome = { role: "editor", revision: "3", body: text("owner draft v3") };
    const api = fakeApi(home);
    render(<ChatCollaboration view={{ kind: "file", scopeId }} api={api} actorId="user_ada" />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "File contents" }), { target: { value: "my local edit" } });
    // The owner saved a new version meanwhile; the home rejects the stale revision.
    home.revision = "4";
    home.body = text("owner draft v4");
    home.writeFailure = unavailable("invalid_request");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The owner changed this file while you were editing.");
    expect(screen.getByRole("textbox", { name: "File contents" })).toHaveValue("my local edit");
    expect(screen.getByLabelText("Owner's version")).toHaveTextContent("owner draft v4");
    expect(api.post).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Download my version" }));
    await waitFor(() => expect(clickedDownloads).toEqual([{ href: "blob:matrix-download", download: "launch-notes (my version).md" }]));
    const saved = createObjectURL.mock.calls[0]![0] as Blob;
    await expect(saved.text()).resolves.toBe("my local edit");

    home.writeFailure = undefined;
    fireEvent.click(screen.getByRole("button", { name: "Keep my edits" }));
    expect(screen.queryByLabelText("Owner's version")).toBeNull();
    expect(screen.getByRole("textbox", { name: "File contents" })).toHaveValue("my local edit");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect(api.post).toHaveBeenLastCalledWith(`${base}/files/actions`, expect.objectContaining({ content: "my local edit", expectedRevision: "4" }));
  });

  it("discards local text only when the Contributor chooses the owner's version", async () => {
    const home: FakeHome = { role: "editor", revision: "3", body: text("owner draft v3") };
    const api = fakeApi(home);
    render(<ChatCollaboration view={{ kind: "file", scopeId }} api={api} actorId="user_ada" />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "File contents" }), { target: { value: "my local edit" } });
    home.revision = "4";
    home.body = text("owner draft v4");
    home.writeFailure = unavailable("invalid_request");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByLabelText("Owner's version");

    fireEvent.click(screen.getByRole("button", { name: "Use the owner's version" }));

    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByLabelText("File preview")).toHaveTextContent("owner draft v4");
  });

  it("keeps the edit and reports a failed save that was not a conflict", async () => {
    const home: FakeHome = { role: "editor", revision: "3", body: text("draft") };
    const api = fakeApi(home);
    render(<ChatCollaboration view={{ kind: "file", scopeId }} api={api} actorId="user_ada" />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "File contents" }), { target: { value: "unsaved" } });
    home.writeFailure = unavailable("host_offline");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Your changes were not saved. The owner's computer is offline.");
    expect(screen.getByRole("textbox", { name: "File contents" })).toHaveValue("unsaved");
    expect(screen.queryByLabelText("Owner's version")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(clickedDownloads).toHaveLength(1));
    expect(screen.getByRole("alert")).toHaveTextContent("Your changes were not saved. The owner's computer is offline.");
  });

  it("says the owner moved or deleted the file when it is missing", async () => {
    for (const home of [
      { role: "viewer" as const, revision: "3", body: text("x"), entries: [] },
      { role: "viewer" as const, revision: "3", body: text("x"), listFailure: unavailable("not_found") },
      { role: "viewer" as const, revision: "3", body: text("x"), contentFailure: unavailable("not_found") },
    ]) {
      const { unmount } = render(<ChatCollaboration view={{ kind: "file", scopeId }} api={fakeApi(home)} actorId="user_ada" />);
      expect(await screen.findByText("This file was moved or deleted by its owner.")).toBeVisible();
      unmount();
    }
  });

  it("separates removed access and an offline owner computer", async () => {
    const removed = render(<ChatCollaboration view={{ kind: "file", scopeId }}
      api={fakeApi({ role: "viewer", revision: "3", body: text("x"), scopeFailure: unavailable("not_found") })} actorId="user_ada" />);
    expect(await screen.findByText("Shared file unavailable")).toBeVisible();
    removed.unmount();

    const home: FakeHome = { role: "viewer", revision: "3", body: text("back online"), scopeFailure: unavailable("host_offline") };
    const api = fakeApi(home);
    render(<ChatCollaboration view={{ kind: "file", scopeId }} api={api} actorId="user_ada" />);
    expect(await screen.findByText("The owner's computer is offline. Try again later.")).toBeVisible();
    home.scopeFailure = undefined;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByLabelText("File preview")).toHaveTextContent("back online");
  });

  it("classifies failures with a typed reason", () => {
    expect(classifySharedFileFailure(unavailable("host_offline"))).toBe("host_offline");
    expect(classifySharedFileFailure(unavailable("unavailable"))).toBe("unavailable");
    expect(classifySharedFileFailure(unavailable("not_found"))).toBe("access_removed");
    expect(classifySharedFileFailure(unavailable("denied"))).toBe("access_removed");
    expect(classifySharedFileFailure(unavailable("invalid_response"))).toBe("unavailable");
    expect(classifySharedFileFailure(new Error("boom"))).toBe("unavailable");
  });

  it("explains a surface that cannot read file content", async () => {
    const api = fakeApi({ role: "viewer", revision: "3", body: text("x") });
    const { getContent: _unused, ...withoutContent } = api;
    render(<ChatCollaboration view={{ kind: "file", scopeId }} api={withoutContent} actorId="user_ada" />);

    expect(await screen.findByText("Files can’t be opened in this version of Matrix.")).toBeVisible();
  });
});
