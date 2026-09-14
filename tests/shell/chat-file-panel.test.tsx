// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatFilePanel, loadChatFile } from "../../shell/src/components/chat/ChatFilePanel";
vi.mock("@/lib/gateway", () => ({ getGatewayUrl: () => "http://localhost:4000" }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("keeps focus in the preview and supports retry and Escape", async () => {
  const fetcher = vi.fn().mockRejectedValueOnce(new Error("Offline")).mockResolvedValue(new Response("Hello", { headers: { "content-type": "text/plain" } }));
  vi.stubGlobal("fetch", fetcher);
  const close = vi.fn();
  render(<ChatFilePanel path="reports/result.txt" onClose={close} />);
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close preview" }));
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Hello")).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("button", { name: "Close preview" }), { key: "Escape" });
  expect(close).toHaveBeenCalledOnce();
});

it("rejects traversal before fetching a preview", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(loadChatFile("../private")).rejects.toThrow("InvalidChatFile");
  expect(fetcher).not.toHaveBeenCalled();
});
