// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProjectPreviewEditor } from "../../desktop/src/renderer/src/features/panels/ProjectPreviewEditor";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";

const invoke = vi.fn(async (channel: string) => channel === "runtime:get-file-content"
  ? { content: "before", truncated: false, metadata: { etag: "etag-1" } }
  : { metadata: { etag: "etag-2" } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("operator", { invoke });
  useConnection.setState({ ...useConnection.getInitialState(), runtimeSlot: "primary", authGeneration: 1 }, true);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("saves a complete worktree edit against its loaded etag", async () => {
  const dirty = vi.fn();
  const props = { projectId: "demo", worktreeId: "wt-1", path: "src/index.ts", onDirtyChange: dirty };
  const { rerender } = render(<ProjectPreviewEditor {...props} saveRequest={0} />);
  const editor = await screen.findByRole("textbox", { name: "Edit src/index.ts" });
  fireEvent.change(editor, { target: { value: "after" } });
  expect(dirty).toHaveBeenCalledWith(true);
  rerender(<ProjectPreviewEditor {...props} saveRequest={1} />);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("runtime:save-file-content", expect.objectContaining({
    projectId: "demo", worktreeId: "wt-1", path: "src/index.ts", content: "after", baseEtag: "etag-1",
  })));
  await waitFor(() => expect(dirty).toHaveBeenCalledWith(false));
});

it("ignores a delayed read after a runtime switch", async () => {
  let finish!: (value: unknown) => void;
  invoke.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const { unmount } = render(<ProjectPreviewEditor projectId="demo" worktreeId="wt-1" path="src/index.ts" saveRequest={0} />);
  useConnection.setState({ runtimeSlot: "other", authGeneration: 2 });
  unmount();
  finish({ content: "private", truncated: false, metadata: { etag: "etag-1" } });
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "Edit src/index.ts" })).toBeNull());
});

it("keeps dirty text and offers reload when the etag write fails", async () => {
  invoke.mockImplementationOnce(async () => ({ content: "before", truncated: false, metadata: { etag: "etag-1" } }));
  invoke.mockImplementationOnce(async () => { throw new Error("conflict"); });
  const props = { projectId: "demo", worktreeId: "wt-1", path: "src/index.ts" };
  const { rerender } = render(<ProjectPreviewEditor {...props} saveRequest={0} />);
  const editor = await screen.findByRole("textbox", { name: "Edit src/index.ts" });
  fireEvent.change(editor, { target: { value: "my edit" } });
  rerender(<ProjectPreviewEditor {...props} saveRequest={1} />);
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Could not save"));
  expect((screen.getByRole("textbox", { name: "Edit src/index.ts" }) as HTMLTextAreaElement).value).toBe("my edit");
});
