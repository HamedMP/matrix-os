// @vitest-environment jsdom
import React from "react";
import {
  act,
  cleanup,
  render,
  renderHook,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useWebChatDraftHandoff } from "../../shell/src/components/chat/useWebChatDraftHandoff";
import { OrganizationDrivesNav } from "../../shell/src/components/chat/OrganizationDrivesNav";
import { useCompanyDriveChatDraft } from "../../shell/src/stores/company-drive-chat-draft";
import { organizationDriveNavigationIdentity } from "../../shell/src/stores/organization-drive-navigation";
vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ userId: "user", sessionId: "session" }),
}));
vi.mock("@/lib/gateway", () => ({
  getGatewayUrl: () => "https://memory.test",
}));
vi.mock("@/hooks/useBrowserOrigin", () => ({ useBrowserOrigin: () => null }));
vi.mock("@matrix-os/ui", () => ({
  OrganizationDrivesNavigation: () => null,
  useChatDriveProjects: () => ({ associations: [] }),
  companyDriveChatReference: () => null,
}));
const identity = organizationDriveNavigationIdentity(
  "user",
  "session",
  "https://memory.test",
);
const reference = {
  kind: "memory_source" as const,
  id: "11111111-1111-4111-8111-111111111111",
  label: "Private note",
  revision: "1",
};
afterEach(() => {
  cleanup();
  useCompanyDriveChatDraft.setState({ request: null });
});
it("does not consume an intent before its reference composer applies it", async () => {
  const start = vi.fn();
  useCompanyDriveChatDraft.getState().openMemory([reference], identity);
  render(<OrganizationDrivesNav onNewChat={start} />);
  // Navigation is not an acknowledgement of draft application.
  expect(useCompanyDriveChatDraft.getState().request).not.toBeNull();
});

it("acknowledges only the intended new draft after reference application", async () => {
  const start = vi.fn().mockReturnValue({ id: 1, scope: "new:1" });
  useCompanyDriveChatDraft.getState().openMemory([reference], identity);
  const { result, rerender } = renderHook(
    ({
      scope,
      sessionId,
      resources,
    }: {
      scope: string;
      sessionId?: string;
      resources: (typeof reference)[];
    }) =>
      useWebChatDraftHandoff({
        scope,
        sessionId,
        resources,
        startDraft: start,
      }),
    {
      initialProps: {
        scope: "existing",
        sessionId: "existing" as string | undefined,
        resources: [] as (typeof reference)[],
      },
    },
  );
  await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
  act(() => result.current.acknowledge(1));
  expect(useCompanyDriveChatDraft.getState().request).not.toBeNull();
  rerender({ scope: "another-chat", sessionId: "another-chat", resources: [] });
  act(() => result.current.acknowledge(1));
  expect(useCompanyDriveChatDraft.getState().request).not.toBeNull();
  rerender({ scope: "new:1", sessionId: undefined, resources: [] });
  act(() => result.current.acknowledge(99));
  expect(useCompanyDriveChatDraft.getState().request).not.toBeNull();
  act(() => result.current.acknowledge(1));
  expect(useCompanyDriveChatDraft.getState().request).not.toBeNull();
  rerender({ scope: "new:1", sessionId: undefined, resources: [reference] });
  expect(useCompanyDriveChatDraft.getState().request).toBeNull();
  expect(start).toHaveBeenCalledWith("", [reference]);
});
it("keeps an intent pending while the target Chat surface is inactive", async () => {
  const start = vi.fn().mockReturnValue({ id: 1, scope: "new:1" });
  useCompanyDriveChatDraft.getState().openMemory([reference], identity);
  const { rerender } = renderHook(
    ({ active }) =>
      useWebChatDraftHandoff({
        active,
        scope: "new:1",
        resources: [],
        startDraft: start,
      }),
    { initialProps: { active: false } },
  );
  expect(start).not.toHaveBeenCalled();
  expect(useCompanyDriveChatDraft.getState().request).not.toBeNull();
  rerender({ active: true });
  await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
});

it("retries an interrupted intent only after Chat reactivation and rejects its old acknowledgement", async () => {
  const start = vi.fn()
    .mockReturnValueOnce({ id: 1, scope: "new:1" })
    .mockReturnValueOnce({ id: 2, scope: "new:2" });
  useCompanyDriveChatDraft.getState().openMemory([reference], identity);
  const request = useCompanyDriveChatDraft.getState().request;
  const { result, rerender } = renderHook(
    ({ active, scope, sessionId, resources }) => useWebChatDraftHandoff({
      active, scope, sessionId, resources, startDraft: start,
    }),
    { initialProps: { active: true, scope: "new:1", sessionId: undefined as string | undefined, resources: [] as (typeof reference)[] } },
  );
  expect(start).toHaveBeenCalledTimes(1);
  rerender({ active: true, scope: "previous", sessionId: "previous", resources: [] });
  act(() => result.current.acknowledge(1));
  expect(start).toHaveBeenCalledTimes(1);
  expect(useCompanyDriveChatDraft.getState().request).toBe(request);
  rerender({ active: false, scope: "previous", sessionId: "previous", resources: [] });
  rerender({ active: true, scope: "previous", sessionId: "previous", resources: [] });
  expect(start).toHaveBeenCalledTimes(2);
  rerender({ active: true, scope: "new:2", sessionId: undefined, resources: [reference] });
  act(() => result.current.acknowledge(1));
  expect(useCompanyDriveChatDraft.getState().request).toBe(request);
  act(() => result.current.acknowledge(2));
  expect(useCompanyDriveChatDraft.getState().request).toBeNull();
});
