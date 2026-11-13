// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatFilePanel, loadChatFile } from "../../shell/src/components/chat/ChatFilePanel";
vi.mock("@/lib/gateway", () => ({ getGatewayUrl: () => "http://localhost:4000" }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each(["budget%20draft.txt", "100%.txt", " note.txt ", "report.txt:42"])("opens the literal filesystem path %s without parsing it as a link", async path => {
  const fetcher = vi.fn(async (url: string) => url.includes("/metadata?") ? Response.json({
    resource: { kind: "home", path }, name: path, mimeType: "text/plain", sizeBytes: 7,
    kind: "text", version: "file_literal", canDownload: true,
  }) : new Response("Literal"));
  vi.stubGlobal("fetch", fetcher);
  render(<ChatFilePanel path={path} onClose={vi.fn()}/>);
  expect(await screen.findByText("Literal")).toBeTruthy();
  expect(new URL(fetcher.mock.calls[0]![0]).searchParams.get("path")).toBe(path);
  expect(new URL(fetcher.mock.calls[1]![0]).searchParams.get("path")).toBe(path);
});

it("keeps an open text preview loaded across unrelated parent renders", async () => {
  const fetcher = vi.fn(async (url: string) => url.includes("/metadata?") ? Response.json({
    resource: { kind: "home", path: "notes.txt" }, name: "notes.txt", mimeType: "text/plain", sizeBytes: 7,
    kind: "text", version: "file_notes", canDownload: true,
  }) : new Response("Content"));
  vi.stubGlobal("fetch", fetcher);
  const view = render(<ChatFilePanel path="notes.txt" gatewayUrl="https://computer.test" onClose={vi.fn()}/>);
  await screen.findByText("Content");
  await act(async () => view.rerender(<ChatFilePanel path="notes.txt" gatewayUrl="https://computer.test" onClose={vi.fn()}/>));
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(screen.getByText("Content")).toBeTruthy();
});

it("keeps a binary preview's object URL across unrelated parent renders", async () => {
  const createObjectURL = vi.fn(() => "blob:preview");
  const revokeObjectURL = vi.fn();
  vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
  const fetcher = vi.fn(async (url: string) => url.includes("/metadata?") ? Response.json({
    resource: { kind: "home", path: "picture.png" }, name: "picture.png", mimeType: "image/png", sizeBytes: 4,
    kind: "image", version: "file_picture", canDownload: true,
  }) : new Response("data", { headers: { "content-type": "image/png" } }));
  vi.stubGlobal("fetch", fetcher);
  const view = render(<ChatFilePanel path="picture.png" onClose={vi.fn()}/>);
  await screen.findByRole("img", { name: "picture.png" });
  await act(async () => view.rerender(<ChatFilePanel path="picture.png" onClose={vi.fn()}/>));
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(createObjectURL).toHaveBeenCalledTimes(1);
  expect(revokeObjectURL).not.toHaveBeenCalled();
});

it("keeps focus in the preview and supports retry and Escape", async () => {
  const fetcher = vi.fn()
    .mockRejectedValueOnce(new Error("Offline"))
    .mockResolvedValueOnce(Response.json({
      resource: { kind: "home", path: "reports/result.txt" }, name: "result.txt",
      mimeType: "text/plain", sizeBytes: 5, kind: "text", version: "file_1", canDownload: true,
    }))
    .mockResolvedValueOnce(new Response("Hello", { headers: { "content-type": "text/plain" } }));
  vi.stubGlobal("fetch", fetcher);
  const close = vi.fn();
  render(<ChatFilePanel path="reports/result.txt" onClose={close} />);
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close preview" }));
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Hello")).toBeTruthy();
  expect(fetcher).toHaveBeenNthCalledWith(2,
    "http://localhost:4000/api/file-previews/metadata?kind=home&path=reports%2Fresult.txt",
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  fireEvent.keyDown(screen.getByRole("button", { name: "Close preview" }), { key: "Escape" });
  expect(close).toHaveBeenCalledOnce();
});

it("rejects traversal before fetching a preview", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(loadChatFile("../private")).rejects.toThrow("InvalidChatFile");
  expect(fetcher).not.toHaveBeenCalled();
});
