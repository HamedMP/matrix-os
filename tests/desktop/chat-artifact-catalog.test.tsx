// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CanonicalChatDetailResponse } from "@matrix-os/contracts";
import { useChatArtifactActions } from "../../desktop/src/renderer/src/features/chat/use-chat-artifact-actions";
const { refetch } = vi.hoisted(() => ({ refetch: vi.fn(async () => undefined) }));
vi.mock("../../desktop/src/renderer/src/features/apps/apps.api", () => ({ useAppsQuery: () => ({ data: [], refetch }) }));
afterEach(() => vi.clearAllMocks());

it("refreshes the installed catalog when a Chat run settles so a newly built app becomes launchable", async () => {
  const makeDetail = (status: string) => ({ runs: [{ id: "run_builder", status }] }) as CanonicalChatDetailResponse;
  const { rerender } = renderHook(({ detail }) => useChatArtifactActions(null, detail, []), { initialProps: { detail: makeDetail("running") } });
  expect(refetch).not.toHaveBeenCalled();
  rerender({ detail: makeDetail("completed") });
  await waitFor(() => expect(refetch).toHaveBeenCalledOnce());
  rerender({ detail: makeDetail("completed") });
  expect(refetch).toHaveBeenCalledOnce();
});
