// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CanonicalChatRecord } from "@matrix-os/contracts";
import { HostedWorkSidebar } from "@desktop/renderer/src/features/work/HostedWorkSidebar";
import { WorkSurfaceRuntimeProvider, useWorkSurfaceRuntime } from "@desktop/renderer/src/features/work/WorkSurfaceRuntime";
import type { CanonicalChatTitleProjection } from "@desktop/renderer/src/features/work/WorkSurfaceRuntime";
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
  WorkRail: (props: {
    onChatRenamed?: (record: CanonicalChatRecord) => void;
    projectedChatTitle?: CanonicalChatTitleProjection;
  }) => (<>
    <button type="button" onClick={() => props.onChatRenamed?.(renamedRecord)}>
      Complete hosted rail rename
    </button>
    <span data-testid="hosted-rail-projected-title">{props.projectedChatTitle?.title ?? "No projection"}</span>
  </>),
}));

function ProjectHeaderRename() {
  const runtime = useWorkSurfaceRuntime();
  return <button type="button" onClick={() => runtime?.projectChat(renamedRecord)}>Complete header rename</button>;
}

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

  it("synchronizes a header rename directly into the mounted hosted rail without a stream event", () => {
    useTabs.getState().openTab({
      kind: "work", title: "Chat", workRoute: "chat", chatId: "chat_global",
      chatTitle: "Old title", chatView: "conversation", closable: false,
    });
    const tab = useTabs.getState().tabs[0]!;

    render(
      <WorkSurfaceRuntimeProvider active={false}>
        <ProjectHeaderRename />
        <HostedWorkSidebar tab={tab} active={false} />
      </WorkSurfaceRuntimeProvider>,
    );
    expect(screen.getByTestId("hosted-rail-projected-title").textContent).toBe("No projection");
    fireEvent.click(screen.getByRole("button", { name: "Complete header rename" }));
    expect(screen.getByTestId("hosted-rail-projected-title").textContent).toBe("Synced title");
  });
});
