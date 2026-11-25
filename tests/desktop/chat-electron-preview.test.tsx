// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import React, { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanonicalChatDetailResponse, CanonicalChatMessage } from "@matrix-os/contracts";
import { type StageChatWorktreeDraft, useChatElectronPreview } from "@desktop/renderer/src/features/chat/ChatElectronPreview";
import {
  CHAT_ELECTRON_PREVIEW_MAX_AGE_MS, CHAT_ELECTRON_PREVIEW_RECEIPT_PREFIX,
  getChatElectronPreviewMarkerForRun, isMacVerificationReceiptRun,
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

function acceptVerificationDraft(
  draft: ReturnType<typeof useChatElectronPreview>["verificationDraft"],
  run: CanonicalChatDetailResponse["runs"][number],
) {
  act(() => {
    const submission = draft?.beginSubmission(run.id);
    if (!submission || submission === "draft-changed") throw new Error("Expected the current verification draft to submit");
    submission.accept(run);
    submission.finish();
  });
}

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
  const { action, feedback, verificationAction, verificationFeedback } = useChatElectronPreview(props);
  return <>{feedback}
    {action ? <button type="button" onClick={() => action.select("@electron")}>{action.label}</button> : null}
    {verificationFeedback}
    {verificationAction ? <button type="button" onClick={() => verificationAction.select("@mac")}>{verificationAction.label}</button> : null}
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

describe("Mac Verification", () => {
  function verificationDetail() {
    const detail = detailWithPreview({ parts: [{ type: "text", text: "Worktree changes are ready." }] });
    const run = detail.runs[0]!;
    run.executionRoot = { kind: "worktree", projectId: project!.projectId, worktreeId: "wt_00000000000a" };
    return detail;
  }

  it("verifies the selected worktree directly with no generated prompt or provider marker", async () => {
    const invoke = vi.fn(async (channel: string) => channel === "chat:electron-preview-available"
      ? { available: false, verificationAvailable: true }
      : { status: "returned" });
    vi.stubGlobal("operator", { invoke });
    const { rerender } = render(<StrictMode><ChatElectronPreview {...initialProps} detail={verificationDetail()} /></StrictMode>);

    const action = await screen.findByRole("button", { name: "Mac Verification" });
    expect(invoke.mock.calls.some(([channel]) => channel === "chat:electron-preview-run")).toBe(false);
    fireEvent.click(action);
    fireEvent.click(action);
    expect(await screen.findByText("Mac verification returned to this Chat.")).toBeTruthy();
    rerender(<StrictMode><ChatElectronPreview {...initialProps} detail={verificationDetail()} /></StrictMode>);

    expect(initialProps.onDraft).not.toHaveBeenCalled();
    expect(invoke.mock.calls.filter(([channel]) => channel === "chat:electron-preview-run")).toEqual([
      ["chat:electron-preview-run", { chatId: chat.id, runId: selectedRun.id, requestKind: "verification" }],
    ]);
  });

  it("binds the current Full Access selection, verifies the previously completed run, and releases on downgrade", async () => {
    const invoke = vi.fn(async (channel: string, _payload: unknown) => {
      if (channel === "chat:electron-preview-available") return { available: false, verificationAvailable: true };
      if (channel === "chat:mac-verification-selection") return { accepted: true };
      return { status: "returned" };
    });
    vi.stubGlobal("operator", { invoke });
    const detail = verificationDetail();
    const { rerender } = render(<ChatElectronPreview {...initialProps} detail={detail} permissionMode="supervised" />);
    await screen.findByRole("button", { name: "Mac Verification" });
    expect(invoke.mock.calls).toHaveLength(1);

    rerender(<ChatElectronPreview {...initialProps} detail={detail} permissionMode="full_access" />);
    fireEvent.click(screen.getByRole("button", { name: "Mac Verification" }));
    expect(await screen.findByText("Mac verification returned to this Chat.")).toBeTruthy();
    const viewId = (invoke.mock.calls[1]?.[1] as { viewId: string }).viewId;
    expect(viewId).toEqual(expect.any(String));
    expect(invoke.mock.calls.slice(1)).toEqual([
      ["chat:mac-verification-selection", { viewId, scope: {
        chatId: chat.id, projectId: project!.projectId, worktreeId: "wt_00000000000a",
      } }],
      ["chat:electron-preview-run", { chatId: chat.id, runId: selectedRun.id, requestKind: "verification", fullAccessViewId: viewId }],
    ]);
    rerender(<ChatElectronPreview {...initialProps} detail={detail} permissionMode="supervised" />);
    expect(invoke).toHaveBeenLastCalledWith("chat:mac-verification-selection", {
      viewId,
      scope: null,
    });
  });

  it("does not send a verification after the native process declines the Full Access selection", async () => {
    const invoke = vi.fn(async (channel: string) => channel === "chat:electron-preview-available"
      ? { available: false, verificationAvailable: true } : { accepted: false });
    vi.stubGlobal("operator", { invoke });
    render(<ChatElectronPreview {...initialProps} detail={verificationDetail()} permissionMode="full_access" />);
    fireEvent.click(await screen.findByRole("button", { name: "Mac Verification" }));
    expect(await screen.findByText(/Check Mac Pairing/)).toBeTruthy();
    expect(invoke.mock.calls.some(([channel]) => channel === "chat:electron-preview-run")).toBe(false);
  });

  it("cancels an edit's waiting Mac verification when the owner changes permission mode", async () => {
    const invoke = vi.fn(async (channel: string) => channel === "chat:electron-preview-available"
      ? { available: false, verificationAvailable: true } : { accepted: true });
    vi.stubGlobal("operator", { invoke });
    const detail = verificationDetail();
    const hook = renderHook(useChatElectronPreview, {
      initialProps: { ...initialProps, detail, permissionMode: "full_access" },
    });
    await waitFor(() => expect(hook.result.current.verificationAction).toBeDefined());
    act(() => hook.result.current.verificationAction?.select("@Mac Verification change", "change"));
    const run = { ...detail.runs[0]!, id: "run_new_edit" };
    acceptVerificationDraft(hook.result.current.verificationDraft, run);
    expect(hook.result.current.verificationFeedback?.props.children[0].props.children).toBe("Waiting for the worktree run…");
    hook.rerender({ ...initialProps, detail, permissionMode: "supervised" });
    hook.rerender({ ...initialProps, detail: { ...detail, runs: [...detail.runs, run] }, permissionMode: "supervised" });
    expect(invoke.mock.calls.some(([channel]) => channel === "chat:electron-preview-run")).toBe(false);
    expect(hook.result.current.verificationFeedback).toBeNull();
  });

  it("recognizes only a supervised native receipt in the existing Chat and worktree", () => {
    const detail = verificationDetail();
    const original = detail.runs[0]!;
    const receipt = { ...original, id: "run_receipt", turnId: "cturn_receipt", permissionMode: "supervised" };
    const requestId = `${CHAT_ELECTRON_PREVIEW_RECEIPT_PREFIX}${"a".repeat(64)}`;
    const turn = { ...detail.turns[0]!, id: receipt.turnId, clientRequestId: requestId };
    detail.runs.push(receipt);
    detail.turns.push(turn);
    expect(isMacVerificationReceiptRun(detail, receipt.id)).toBe(true);
    turn.clientRequestId = "req_other";
    expect(isMacVerificationReceiptRun(detail, receipt.id)).toBe(false);
    turn.clientRequestId = requestId;
    receipt.executionRoot = { kind: "worktree", projectId: detail.record.projectId!, worktreeId: "wt_00000000000b" };
    expect(isMacVerificationReceiptRun(detail, receipt.id)).toBe(false);
  });

  it("does not use the legacy preview capability to expose Mac Verification", async () => {
    vi.stubGlobal("operator", { invoke: vi.fn(async () => ({ available: true })) });
    render(<ChatElectronPreview {...initialProps} detail={verificationDetail()} />);
    await screen.findByRole("button", { name: "Request Electron preview" });
    expect(screen.queryByRole("button", { name: "Mac Verification" })).toBeNull();
  });

  it("does not expose Mac Verification for an expired worktree run", async () => {
    const invoke = vi.fn(async () => ({ available: true, verificationAvailable: true }));
    vi.stubGlobal("operator", { invoke });
    const detail = verificationDetail();
    detail.runs[0]!.completedAt = new Date(Date.now() - CHAT_ELECTRON_PREVIEW_MAX_AGE_MS - 1000).toISOString();
    render(<ChatElectronPreview {...initialProps} detail={detail} />);
    await screen.findByRole("button", { name: "Request Electron preview" });
    expect(screen.queryByRole("button", { name: "Mac Verification" })).toBeNull();
  });
});
