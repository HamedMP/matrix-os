// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ToolCallGroup } from "../../shell/src/components/ToolCallGroup";
import { projectCanonicalMessages } from "../../shell/src/lib/canonical-chat-client";
afterEach(cleanup);
it("loads saved tool images through the selected computer's image loader", async () => {
  const src = "/api/chats/chat_history/imports/assets/019eb0ae-9a30-7541-bdb8-db4d17e65146/content";
  const loadImage = vi.fn(() => new Promise<Blob>(() => {}));
  render(<ToolCallGroup loadImage={loadImage} tools={[{ id: "tool_image", role: "system", tool: "Read image", content: "Used Read image", timestamp: 0,
    toolDisplay: { id: "tool_image", kind: "tool", state: "completed", label: "Read image" },
    attachments: [{ id: "image", kind: "image", label: "Imported image", src }] }]} />);
  fireEvent.click(screen.getByRole("button"));
  await waitFor(() => expect(loadImage).toHaveBeenCalledWith(src));
});
it("keeps imported output collapsed and exposes the saved full input inside its completed tool", () => {
  const provenance = { type: "import_provenance" as const, harness: "codex" as const, sourceId: "source", sourceKey: "key", phase: "tool" as const, origin: "tool" as const, offset: 0, end: 1 };
  const base = { chatId: "chat_history", role: "tool" as const, state: "committed" as const, createdAt: "2026-10-18T00:00:00Z" };
  const asset = { type: "import_reference" as const, assetId: "019eb0ae-9a30-7541-bdb8-db4d17e65146", kind: "tool_input" as const, label: "Full tool input", mimeType: "text/plain", sizeBytes: 32 };
  const tools = projectCanonicalMessages([
    { ...base, id: "msg_call", seq: 1, parts: [{ type: "tool_request", toolCallId: "call_one", name: "Read", label: "Read file" }, asset, provenance] },
    { ...base, id: "msg_result", seq: 2, parts: [{ type: "tool_result", toolCallId: "call_one", outcome: "success", text: "Actual saved result" }, provenance] },
  ]);
  render(<ToolCallGroup tools={tools} openImportedAsset={async () => {}} />);
  expect(screen.queryByText("Actual saved result")).toBeNull();
  expect(screen.queryByLabelText("Running")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Read file\s*Completed/ }));
  expect(screen.getByText("Actual saved result")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Download Full tool input" })).toHaveProperty("disabled", false);
});

it("shows the full command and result when a single canonical tool expands", () => {
  render(<ToolCallGroup tools={[{ id: "tool_test", role: "system", content: "Used Run command", timestamp: 0, tool: "Run command", toolDisplay: { id: "tool_test", kind: "command", state: "failed", label: "Run command", preview: "bun run test", previewKind: "command", detail: "Working directory: projects/demo\n\n1 test failed" } }]} />);
  expect(screen.getByText("bun run test")).toBeTruthy();
  fireEvent.click(screen.getByRole("button"));
  expect(screen.getByText(/1 test failed/)).toBeTruthy();
  expect(screen.getAllByLabelText("Failed").length).toBeGreaterThan(0);
});

it("shows the image generation glare while the canonical activity is running", () => {
  render(<ToolCallGroup tools={[{
    id: "tool_image", role: "system", content: "Using Generating image", timestamp: 0,
    tool: "Generating image",
    toolDisplay: { id: "tool_image", kind: "image_generation", state: "running", label: "Generating image" },
  }]} />);
  expect(screen.getByRole("status", { name: "Generating image" }).className).toContain("image-generation-glare");
});
