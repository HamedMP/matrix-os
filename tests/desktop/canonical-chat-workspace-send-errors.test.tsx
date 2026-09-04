// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CanonicalChatWorkspace } from "@desktop/renderer/src/features/chat/CanonicalChatWorkspace";
import { useBoard } from "@desktop/renderer/src/stores/board";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { AppError } from "@desktop/shared/app-error";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";
import {
  createCanonicalChatWorkspaceClient as client,
  providerCatalog,
} from "./canonical-chat-workspace-test-utils";
import { setSharedComposerText } from "./shared-chat-composer-test-utils";

class WorkspaceResizeObserver implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}

describe("CanonicalChatWorkspace send failures", () => {
  beforeEach(() => {
    globalThis.ResizeObserver = WorkspaceResizeObserver;
    useBoard.setState(useBoard.getInitialState(), true);
    useConnection.setState(useConnection.getInitialState(), true);
    window.operator = {
      invoke: vi.fn(async () => ({ ok: true })),
      on: vi.fn(() => () => undefined),
    };
  });

  afterEach(cleanup);

  it("shows the safe attachment upload reason", async () => {
    const api = {
      putBytes: vi.fn(async () => { throw new AppError("offline"); }),
    } as never;
    const routeClient = client();
    vi.mocked(routeClient.list).mockResolvedValue({ items: [] });
    render(
      <CanonicalChatWorkspace
        api={api}
        client={routeClient}
        projectId="matrix-os"
        projectLabel="Matrix OS"
        active
        catalog={providerCatalog}
      />,
    );
    await setSharedComposerText(
      await screen.findByRole("textbox", { name: "Start a chat" }),
      "Inspect this file",
    );
    fireEvent.change(screen.getByLabelText("Choose files"), {
      target: { files: [new File(["notes"], "notes.txt", { type: "text/plain" })] },
    });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "The message could not be sent. Reason: Attachment upload failed. Can't reach Matrix OS. Check your connection.",
    );
    expect(routeClient.create).not.toHaveBeenCalled();
  });

  it("explains when the selected provider cannot send files", async () => {
    const routeClient = client();
    vi.mocked(routeClient.list).mockResolvedValue({ items: [] });
    const catalogWithoutAttachments = {
      ...providerCatalog,
      instances: providerCatalog.instances.map((instance) => ({
        ...instance,
        supports: { ...instance.supports, attachments: [] },
      })),
    };
    render(
      <CanonicalChatWorkspace
        client={routeClient}
        projectId="matrix-os"
        projectLabel="Matrix OS"
        active
        catalog={catalogWithoutAttachments}
      />,
    );
    await setSharedComposerText(
      await screen.findByRole("textbox", { name: "Start a chat" }),
      "Inspect this file",
    );
    fireEvent.change(screen.getByLabelText("Choose files"), {
      target: { files: [new File(["notes"], "notes.txt", { type: "text/plain" })] },
    });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "The message could not be sent. Reason: The selected provider does not support file attachments.",
    );
    expect(routeClient.create).not.toHaveBeenCalled();
  });

  it("clears a queued message during admission and restores it after a definitive failure", async () => {
    const running = createCanonicalChatFixture("running").snapshot;
    const runningRecord = {
      chat: running.chat,
      projectId: "matrix-os",
      providerBinding: running.chat.providerBinding,
      activeRun: running.chat.activeRun,
    };
    let rejectQueue!: (error: Error) => void;
    const queueRequest = new Promise<never>((_resolve, reject) => { rejectQueue = reject; });
    const routeClient = client();
    vi.mocked(routeClient.list).mockResolvedValue({ items: [runningRecord] });
    vi.mocked(routeClient.getDetail).mockResolvedValue({
      record: runningRecord,
      messages: running.messages,
      turns: running.turns,
      runs: [{
        ...running.runs[0]!,
        capabilitySnapshot: { ...running.runs[0]!.capabilitySnapshot, steering: "same_run" },
      }],
      activities: running.activities,
      queuedTurns: [],
    });
    vi.mocked(routeClient.queueTurn).mockReturnValue(queueRequest);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    render(
      <CanonicalChatWorkspace
        client={routeClient}
        projectId="matrix-os"
        projectLabel="Matrix OS"
        initialChatId={running.chat.id}
        initialView="conversation"
        active
        catalog={providerCatalog}
      />,
    );
    const editor = await screen.findByRole("textbox", { name: "Reply to chat" });
    await setSharedComposerText(editor, "Keep this message if queueing fails");

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(routeClient.queueTurn).toHaveBeenCalledTimes(1));
    expect(editor.textContent).toBe("");
    expect(screen.queryByText("Keep this message if queueing fails")).toBeNull();

    rejectQueue(new AppError("offline"));

    await waitFor(() => expect(editor.textContent).toBe("Keep this message if queueing fails"));
    const alert = await screen.findByRole("alert");
    const detailCallsWhenErrorAppeared = vi.mocked(routeClient.getDetail).mock.calls.length;
    await waitFor(() => {
      expect(vi.mocked(routeClient.getDetail).mock.calls.length).toBeGreaterThan(
        detailCallsWhenErrorAppeared,
      );
    });
    expect(screen.getByRole("alert")).toBe(alert);
    expect(screen.getByRole("alert").textContent).toBe(
      "The message could not be queued. Refresh and try again.",
    );
    warn.mockRestore();
  });
});
