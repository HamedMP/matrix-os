// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CanonicalChatDetailResponse } from "@matrix-os/contracts";
import { useChatArtifactActions } from "../../desktop/src/renderer/src/features/chat/use-chat-artifact-actions";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";
const { refetch } = vi.hoisted(() => ({ refetch: vi.fn(async () => undefined) }));
vi.mock("../../desktop/src/renderer/src/features/apps/apps.api", () => ({ useAppsQuery: () => ({ data: [{ slug: "chart", name: "Chart", path: "apps/chart/index.html" }], refetch }) }));
afterEach(() => vi.clearAllMocks());
function makeDetail(status: "running" | "completed"): CanonicalChatDetailResponse {
  const { snapshot } = createCanonicalChatFixture("completed");
  return { record: { chat: snapshot.chat }, messages: snapshot.messages, turns: snapshot.turns,
    runs: snapshot.runs.map((run) => ({ ...run, status })), activities: snapshot.activities };
}

it("refreshes the installed catalog when a Chat run settles so a newly built app becomes launchable", async () => {
  const { rerender } = renderHook(({ detail }) => useChatArtifactActions(null, detail, []), { initialProps: { detail: makeDetail("running") } });
  expect(refetch).not.toHaveBeenCalled();
  rerender({ detail: makeDetail("completed") });
  await waitFor(() => expect(refetch).toHaveBeenCalledOnce());
  rerender({ detail: makeDetail("completed") });
  expect(refetch).toHaveBeenCalledOnce();
});

it("launches relative apps only from home and honors a persisted project run root", () => {
  const { result } = renderHook(() => useChatArtifactActions(null, makeDetail("running"), []));
  expect(result.current.resolveApp("apps/chart")?.name).toBe("Chart");
  expect(result.current.resolveApp("apps/chart", { kind: "worktree", projectId: "project_1", worktreeId: "wt_1" })).toBeNull();
  expect(result.current.resolveApp("~/apps/chart", { kind: "project", projectId: "project_1" })?.name).toBe("Chart");
});
