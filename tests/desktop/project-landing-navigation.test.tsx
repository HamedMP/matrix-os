// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { clearChatNavigationScopes } from "@matrix-os/ui";
import type { CanonicalChatClient } from "@desktop/renderer/src/lib/canonical-chat-client";
import { useWorkNavigation } from "@desktop/renderer/src/features/work/use-work-navigation";
import { useProjectLandingChats } from "@desktop/renderer/src/features/project/use-project-landing-chats";

afterEach(() => { cleanup(); clearChatNavigationScopes(); });

it("shares the rail's real navigation store across Project remounts and selection", async () => {
  const project = { id: "project_alpha", slug: "alpha", name: "Alpha", kind: "folder" as const };
  const client = {
    navigation: vi.fn(async () => ({ version: 1, truncated: false, items: [{
      chat: { id: "chat_project", title: "Project planning", titleVersion: 1, revision: 1, lifecycle: "active", attention: "none", messageCount: 0, createdAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z" },
      projectId: project.id,
      readState: { version: 0, unread: false, markedUnread: false, latestIncomingSeq: 0, readThroughSeq: 0 },
      classification: { kind: "ordinary" }, persistence: "personal",
    }] })),
    list: vi.fn(),
    agents: { list: vi.fn(), bots: { directBot: vi.fn() } },
  } as unknown as CanonicalChatClient;
  // Keep the rail's navigation owner mounted while Project surfaces come and go.
  const rail = renderHook(() => useWorkNavigation(client, undefined, true));
  await waitFor(() => expect(rail.result.current.items).toHaveLength(1));
  const first = renderHook(({ selected }) => useProjectLandingChats(selected, client), { initialProps: { selected: project } });
  expect(first.result.current.chats.map(record => record.chat.id)).toEqual(["chat_project"]);
  first.rerender({ selected: { ...project, id: "project_other", slug: "other" } });
  expect(first.result.current.chats).toEqual([]);
  first.unmount();
  const second = renderHook(() => useProjectLandingChats(project, client));
  expect(second.result.current.chats.map(record => record.chat.id)).toEqual(["chat_project"]);
  expect(client.navigation).toHaveBeenCalledOnce();
  expect(client.list).not.toHaveBeenCalled();
  expect(client.agents!.list).not.toHaveBeenCalled();
  expect(client.agents!.bots!.directBot).not.toHaveBeenCalled();
});
