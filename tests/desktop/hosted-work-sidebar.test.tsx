// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CanonicalChatRecord } from "@matrix-os/contracts";
import { HostedWorkSidebar } from "@desktop/renderer/src/features/work/HostedWorkSidebar";
import { useTabs } from "@desktop/renderer/src/stores/tabs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const renamedRecord: CanonicalChatRecord = {
  chat: {
    id: "chat_global",
    ownerScope: { type: "personal", ownerId: "owner_test" },
    title: "Synced title",
    lifecycle: "active",
    attention: "none",
    revision: 2,
    messageCount: 1,
    userState: { readThroughSeq: 0, pinned: false, muted: false },
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T01:00:00.000Z",
  },
};

vi.mock("@desktop/renderer/src/features/work/WorkRail", () => ({
  WorkRail: (props: { onChatRenamed?: (record: CanonicalChatRecord) => void }) => (
    <button type="button" onClick={() => props.onChatRenamed?.(renamedRecord)}>
      Complete hosted rail rename
    </button>
  ),
}));

beforeEach(() => {
  useTabs.setState(useTabs.getInitialState(), true);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("HostedWorkSidebar", () => {
  it("synchronizes a rail rename into the active center-title projection", () => {
    useTabs.getState().openTab({
      kind: "work",
      title: "Chat",
      workRoute: "chat",
      chatId: "chat_global",
      chatTitle: "Old title",
      chatView: "conversation",
      closable: false,
    });
    const tab = useTabs.getState().tabs[0]!;

    render(<HostedWorkSidebar tab={tab} active />);
    fireEvent.click(screen.getByRole("button", { name: "Complete hosted rail rename" }));

    expect(useTabs.getState().tabs[0]?.chatTitle).toBe("Synced title");
  });
});
