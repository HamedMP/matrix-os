// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryWorkspaceApp } from "../../shell/src/components/memory-workspace/MemoryWorkspaceApp";
import DesktopMemoryWorkspace from "../../desktop/src/renderer/src/features/memory-workspace/DesktopMemoryWorkspace";

const harness = vi.hoisted(() => ({
  post: vi.fn(), webOpen: vi.fn(), desktopOpen: vi.fn(), openWindow: vi.fn(),
}));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: "owner", sessionId: "session" }) }));
vi.mock("@/lib/gateway", () => ({ getGatewayUrl: () => "https://memory.test" }));
vi.mock("@/lib/self-host-mode", () => ({ isSelfHostedRuntime: () => false }));
vi.mock("@/api/http", () => ({ createShellApiClient: () => ({ post: harness.post }) }));
vi.mock("@/stores/company-drive-chat-draft", () => ({
  useCompanyDriveChatDraft: { getState: () => ({ openMemory: harness.webOpen }) },
}));
vi.mock("@/hooks/useWindowManager", () => ({
  useWindowManager: { getState: () => ({ openWindow: harness.openWindow }) },
}));
vi.mock("../../desktop/src/renderer/src/stores/connection", () => {
  const state = { api: { forRuntime: () => ({ post: harness.post }) }, runtimeSlot: "primary" };
  return { useConnection: Object.assign((select: (value: typeof state) => unknown) => select(state), { getState: () => state }) };
});
vi.mock("../../desktop/src/renderer/src/stores/tabs", () => ({ useTabs: {} }));
vi.mock("../../desktop/src/renderer/src/stores/company-drive-chat-draft", () => ({
  desktopDriveDraftIdentity: () => "desktop-owner", openDesktopMemoryChat: harness.desktopOpen,
}));
vi.mock("@matrix-os/ui", async importOriginal => {
  const original = await importOriginal<typeof import("@matrix-os/ui")>();
  return { ...original, MemoryWorkspace: ({ onUseInChat }: { onUseInChat: (ids: string[]) => Promise<void> }) =>
    <button onClick={() => void onUseInChat(["selected-source"])}>Use in Chat</button> };
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("routes identical shared Memory receipts through actual Web and Electron adapters", async () => {
  const sources = Array.from({ length: 10 }, (_, i) => ({ sourceId: `source-${i}`, title: `Note ${i}`, revision: i + 1 }));
  harness.post.mockResolvedValue({ sources, text: "Private content never enters the draft", estimatedTokens: 10 });
  const web = render(<MemoryWorkspaceApp />);
  fireEvent.click(screen.getByRole("button", { name: "Use in Chat" }));
  await waitFor(() => expect(harness.webOpen).toHaveBeenCalledOnce());
  web.unmount();
  render(<DesktopMemoryWorkspace />);
  fireEvent.click(screen.getByRole("button", { name: "Use in Chat" }));
  await waitFor(() => expect(harness.desktopOpen).toHaveBeenCalledOnce());
  const webReferences = harness.webOpen.mock.calls[0]![0];
  expect(harness.desktopOpen).toHaveBeenCalledWith(webReferences, "desktop-owner");
  expect(webReferences).toHaveLength(8);
  expect(webReferences[0]).toEqual({ kind: "memory_source", id: "source-0", label: "Note 0", revision: "1" });
  expect(JSON.stringify(webReferences)).not.toContain("Private content");
  expect(harness.post).toHaveBeenCalledWith("/api/memory-workspace/context", { sourceIds: ["selected-source"] });
});
