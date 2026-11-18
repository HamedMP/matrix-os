// @vitest-environment jsdom
import React, { useRef } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ApiClient } from "../../desktop/src/renderer/src/lib/api";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useConversationAttachments } from "../../desktop/src/renderer/src/features/chat/attachments/use-conversation-attachments";
import { useMatrixAttachmentControls } from "../../desktop/src/renderer/src/features/chat/attachments/use-matrix-attachment-controls";
import {
  beginMatrixFileDrag,
  MATRIX_FILE_DRAG_TYPE,
} from "../../desktop/src/renderer/src/features/chat/attachments/matrix-file-attachment";

vi.mock("../../desktop/src/renderer/src/features/panels/InspectorFilesPanel", () => ({
  InspectorFilesPanel: ({ onOpenFile }: { onOpenFile: (entry: { kind: "home"; path: string; label: string }) => void }) => (
    <button type="button" onClick={() => onOpenFile({ kind: "home", path: "notes/report.txt", label: "report.txt" })}>
      Attach report.txt
    </button>
  ),
}));

const getBlob = vi.fn<ApiClient["getBlob"]>();
const api = { getBlob, forRuntime: vi.fn(() => ({ getBlob })) } as unknown as ApiClient;
const validate = vi.fn<(files: readonly File[]) => string | null>();

function Composer({ chat }: { chat: string }) {
  const input = useRef<HTMLInputElement>(null);
  const queue = useConversationAttachments(chat, api);
  const controls = useMatrixAttachmentControls({ api, scopeKey: chat, enabled: true,
    locked: false, queue, deviceInput: input, validate });
  return <section aria-label="Composer" {...controls.paneProps}>
    <input ref={input} type="file" />
    <button type="button" onClick={controls.onAttach}>Attach files</button>
    {queue.items.map(item => <span key={item.localId}>{item.file.name}</span>)}
    {controls.error ? <p role="alert">{controls.error}</p> : null}
    {controls.dialog}
  </section>;
}

function dragFromMatrix() {
  let token = "";
  const transfer = {
    types: [MATRIX_FILE_DRAG_TYPE],
    setData: (_type: string, value: string) => { token = value; },
    getData: () => token,
    effectAllowed: "all",
  };
  beginMatrixFileDrag(transfer, { kind: "home", path: "notes/report.txt" });
  return transfer;
}

beforeEach(() => {
  useConnection.setState({ api, runtimeSlot: "primary", authGeneration: 1 });
  getBlob.mockReset().mockResolvedValue(new Blob(["report"], { type: "text/plain" }));
  validate.mockReset().mockReturnValue(null);
});
afterEach(() => { cleanup(); useConnection.setState(useConnection.getInitialState(), true); });

it("adds a Matrix file through the picker and rejects a repeated drop before reading", async () => {
  render(<Composer chat="chat-a" />);
  fireEvent.click(screen.getByRole("button", { name: "Attach files" }));
  fireEvent.click(await screen.findByRole("button", { name: "Attach report.txt" }));
  expect(await screen.findByText("report.txt", { exact: true })).toBeTruthy();
  fireEvent.drop(screen.getByRole("region", { name: "Composer" }), { dataTransfer: dragFromMatrix() });
  expect((await screen.findByRole("alert")).textContent).toContain("already attached");
  expect(getBlob).toHaveBeenCalledOnce();
});

it("cancels Matrix reads on Chat switch and preserves native file drops", async () => {
  let complete!: (blob: Blob) => void;
  getBlob.mockReturnValueOnce(new Promise<Blob>(resolve => { complete = resolve; }));
  const view = render(<Composer chat="chat-a" />);
  fireEvent.drop(screen.getByRole("region", { name: "Composer" }), { dataTransfer: dragFromMatrix() });
  await waitFor(() => expect(getBlob).toHaveBeenCalledOnce());
  view.rerender(<Composer chat="chat-b" />);
  expect(getBlob.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  await act(async () => complete(new Blob(["stale"])));
  expect(screen.queryByText("report.txt")).toBeNull();
  fireEvent.drop(screen.getByRole("region", { name: "Composer" }), {
    dataTransfer: { types: ["Files"], files: [new File(["local"], "local.txt", { type: "text/plain" })] },
  });
  expect(await screen.findByText("local.txt")).toBeTruthy();
});

it("leaves Matrix files out of the queue on a read or provider-policy failure", async () => {
  getBlob.mockRejectedValueOnce(new Error("missing"));
  render(<Composer chat="chat-a" />);
  const composer = screen.getByRole("region", { name: "Composer" });
  fireEvent.drop(composer, { dataTransfer: dragFromMatrix() });
  expect((await screen.findByRole("alert")).textContent).toContain("Could not read that Matrix file");
  validate.mockReturnValueOnce("The selected model does not accept this file.");
  fireEvent.drop(composer, { dataTransfer: dragFromMatrix() });
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("does not accept this file"));
  expect(screen.queryByText("report.txt")).toBeNull();
});
