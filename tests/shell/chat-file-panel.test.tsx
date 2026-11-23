// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatFilePanel, loadChatFile } from "../../shell/src/components/chat/ChatFilePanel";
vi.mock("@/lib/gateway", () => ({ getGatewayUrl: () => "http://localhost:4000" }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

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

it("downloads the authenticated image bytes already loaded by Web Chat File Preview", async () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 42]);
  const fetcher = vi.fn()
    .mockResolvedValueOnce(Response.json({
      resource: { kind: "home", path: "reports/result.png" }, name: "result.png",
      mimeType: "image/png", sizeBytes: bytes.length, kind: "image", version: "file_2", canDownload: true,
    }))
    .mockResolvedValueOnce(new Response(bytes, { headers: { "content-type": "image/png" } }));
  vi.stubGlobal("fetch", fetcher);
  const createObjectURL = vi.fn((_blob: Blob) => "blob:result");
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = createObjectURL;
    static revokeObjectURL = vi.fn();
  });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  render(<ChatFilePanel path="reports/result.png" onClose={vi.fn()} />);
  const download = await screen.findByRole("button", { name: "Download image" });
  fireEvent.click(download);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(createObjectURL.mock.calls[0][0]).toBe(createObjectURL.mock.calls.at(-1)?.[0]);
  const loadedBytes = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(createObjectURL.mock.calls[0]![0]);
  });
  expect(loadedBytes).toEqual(bytes.buffer);
  expect(click.mock.contexts[0]).toMatchObject({ href: "blob:result", download: "result.png" });
});
