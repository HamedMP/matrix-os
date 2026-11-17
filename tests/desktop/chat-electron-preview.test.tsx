// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React, { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanonicalChatDetailResponse, CanonicalChatMessage } from "@matrix-os/contracts";
import { type StageChatWorktreeDraft, useChatElectronPreview } from "@desktop/renderer/src/features/chat/ChatElectronPreview";
import {
  CHAT_ELECTRON_PREVIEW_MAX_AGE_MS,
  getChatElectronPreviewMarkerForRun,
  parseChatElectronPreviewMarker,
} from "@desktop/shared/chat-electron-preview";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";

const marker = {
  baseSha: "b".repeat(40),
  sourceSha256: "c".repeat(64),
  label: "YOUR SPACE TO BUILD",
  mainChecksPassed: true,
};
const markerLine = `MATRIX_ELECTRON_PREVIEW_V1 ${JSON.stringify(marker)}`;
const { snapshot } = createCanonicalChatFixture("completed");
const { project, providerBinding, ...chat } = snapshot.chat;
const selectedRun = {
  ...snapshot.runs[0]!,
  executionRoot: { kind: "worktree", projectId: project!.projectId, worktreeId: "wt_preview" } as const,
};

function detailWithPreview(message: Partial<CanonicalChatMessage> = {}): CanonicalChatDetailResponse {
  return {
    record: { chat, projectId: project?.projectId, providerBinding },
    messages: [...snapshot.messages, {
      id: "msg_preview",
      chatId: chat.id,
      role: "assistant",
      state: "committed",
      seq: 2,
      runId: selectedRun.id,
      turnId: selectedRun.turnId,
      createdAt: new Date().toISOString(),
      parts: [{ type: "text", text: `Source checks passed.\n${markerLine}` }],
      ...message,
    }],
    runs: [{ ...selectedRun, completedAt: new Date().toISOString() }],
    turns: snapshot.turns,
    activities: [],
  };
}

const initialProps = {
  active: true,
  actorId: chat.ownerScope.ownerId,
  onDraft: vi.fn<StageChatWorktreeDraft>(() => true),
};

function ChatElectronPreview(props: Parameters<typeof useChatElectronPreview>[0]) {
  const { action, feedback } = useChatElectronPreview(props);
  return <>{feedback}
    {action ? <button type="button" onClick={() => action.select("@electron")}>{action.label}</button> : null}
  </>;
}

function previewBridge(firstStatus = "returned") {
  const invoke = vi.fn().mockResolvedValueOnce({ available: true }).mockResolvedValueOnce({ status: firstStatus });
  vi.stubGlobal("operator", { invoke });
  return invoke;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  initialProps.onDraft.mockClear();
});

describe("Electron preview marker", () => {
  it("accepts only a single bounded marker with an inert label and passing Main checks", () => {
    expect(parseChatElectronPreviewMarker(`Summary\r\n${markerLine}\r\nDone.`)).toEqual(marker);
    for (const invalid of [
      `${markerLine}\n${markerLine}`,
      `Quoted ${markerLine}`,
      ["```json", markerLine, "```"].join("\n"),
      ["~~~json", markerLine, "~~~"].join("\n"),
      `MATRIX_ELECTRON_PREVIEW_V1 ${JSON.stringify({ ...marker, mainChecksPassed: false })}`,
      `MATRIX_ELECTRON_PREVIEW_V1 ${JSON.stringify({ ...marker, arbitraryPath: "/tmp/source" })}`,
      `MATRIX_ELECTRON_PREVIEW_V1 ${JSON.stringify({ ...marker, label: "X {doThing()}" })}`,
      `MATRIX_ELECTRON_PREVIEW_V1 ${JSON.stringify({ ...marker, label: "A".repeat(56) })}`,
    ]) expect(parseChatElectronPreviewMarker(invalid)).toBeNull();
  });

  it("accepts only a committed assistant marker bound to the selected run", () => {
    expect(getChatElectronPreviewMarkerForRun(detailWithPreview(), selectedRun.id)).toEqual(marker);
    expect(getChatElectronPreviewMarkerForRun(detailWithPreview({ role: "user" }), selectedRun.id)).toBeNull();
    expect(getChatElectronPreviewMarkerForRun(detailWithPreview({ state: "pending" }), selectedRun.id)).toBeNull();
    expect(getChatElectronPreviewMarkerForRun(detailWithPreview({ turnId: "cturn_other" }), selectedRun.id)).toBeNull();
    expect(getChatElectronPreviewMarkerForRun(detailWithPreview({ chatId: "chat_other" }), selectedRun.id)).toBeNull();
    const detail = detailWithPreview();
    detail.messages.push({ ...detail.messages.at(-1)!, id: "msg_duplicate", seq: 3 });
    expect(getChatElectronPreviewMarkerForRun(detail, selectedRun.id)).toBeNull();
  });
});

describe("Electron Chat preview", () => {
  it("requests native approval once under StrictMode and keeps the returned status on refresh", async () => {
    const invoke = previewBridge();
    const { rerender } = render(<StrictMode>
      <ChatElectronPreview {...initialProps} detail={detailWithPreview()} />
    </StrictMode>);
    expect(await screen.findByText("Electron preview returned to this Chat.")).toBeTruthy();
    rerender(<StrictMode><ChatElectronPreview {...initialProps} detail={detailWithPreview()} /></StrictMode>);
    expect(invoke.mock.calls.filter(([channel]) => channel === "chat:electron-preview-run")).toEqual([
      ["chat:electron-preview-run", { chatId: chat.id, runId: selectedRun.id }],
    ]);
  });

  it.each(["inactive", "other-owner", "archived", "expired", "failed-latest", "wrong-root"] as const)(
    "does not invoke approval for an ineligible Chat or run (%s)", async (reason) => {
      const invoke = previewBridge();
      const detail = detailWithPreview();
      if (reason === "archived") detail.record.chat = { ...chat, lifecycle: "archived" };
      if (reason === "expired") detail.runs[0]!.completedAt =
        new Date(Date.now() - CHAT_ELECTRON_PREVIEW_MAX_AGE_MS - 1_000).toISOString();
      if (reason === "failed-latest") detail.runs.push({ ...selectedRun, id: "run_other", status: "failed" });
      if (reason === "wrong-root") detail.runs[0]!.executionRoot = { kind: "project", projectId: project!.projectId };
      render(<ChatElectronPreview {...initialProps} detail={detail}
        active={reason !== "inactive"} actorId={reason === "other-owner" ? "user_other" : initialProps.actorId} />);
      if (reason === "expired" || reason === "failed-latest") {
        await screen.findByRole("button", { name: "Request Electron preview" });
      }
      if (reason === "wrong-root") {
        await waitFor(() => expect(invoke).toHaveBeenCalledWith("chat:electron-preview-available", {}));
        expect(screen.queryByRole("button", { name: "Request Electron preview" })).toBeNull();
      }
      expect(invoke.mock.calls.some(([channel]) => channel === "chat:electron-preview-run")).toBe(false);
    },
  );

  it("lets the user explicitly retry a busy request", async () => {
    const invoke = previewBridge("busy").mockResolvedValueOnce({ status: "returned" });
    render(<ChatElectronPreview {...initialProps} detail={detailWithPreview()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry preview" }));
    expect(await screen.findByText("Electron preview returned to this Chat.")).toBeTruthy();
    expect(invoke.mock.calls.filter(([channel]) => channel === "chat:electron-preview-run")).toHaveLength(2);
  });

  it("prepares a draft for the worktree protocol without sending or running commands", async () => {
    const invoke = previewBridge();
    const detail = detailWithPreview({ parts: [{ type: "text", text: "No preview marker." }] });
    render(<ChatElectronPreview {...initialProps} detail={detail} />);
    fireEvent.click(await screen.findByRole("button", { name: "Request Electron preview" }));
    await waitFor(() => expect(initialProps.onDraft).toHaveBeenCalledOnce());
    expect(initialProps.onDraft.mock.calls[0]?.[0]).toContain("MATRIX_ELECTRON_PREVIEW_V1");
    expect(invoke.mock.calls.every(([channel]) => channel === "chat:electron-preview-available")).toBe(true);
  });
});
