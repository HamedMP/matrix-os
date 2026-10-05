// @vitest-environment jsdom
import React, { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ChatAgentDraftRequest, StartAgentChat } from "@matrix-os/ui";
import { ChatInput } from "../../shell/src/components/chat/ChatInput";
import { useWebChatDraftHandoff } from "../../shell/src/components/chat/useWebChatDraftHandoff";
import { useChatComposerDraft } from "../../shell/src/components/chat/useChatComposerDraft";
import { useCompanyDriveChatDraft } from "../../shell/src/stores/company-drive-chat-draft";
import { organizationDriveNavigationIdentity } from "../../shell/src/stores/organization-drive-navigation";
vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ userId: "user", sessionId: "session" }),
  useOrganization: () => ({ organization: null }),
}));
vi.mock("@/lib/gateway", () => ({
  getGatewayUrl: () => "https://memory.test",
}));
const identity = organizationDriveNavigationIdentity(
  "user",
  "session",
  "https://memory.test",
);
const reference = {
  kind: "memory_source" as const,
  id: "11111111-1111-4111-8111-111111111111",
  label: "Private original",
  revision: "1",
};
const submit = vi.fn();
afterEach(() => {
  cleanup();
  useCompanyDriveChatDraft.setState({ request: null });
  submit.mockClear();
});
function MountedChat() {
  const [sessionId, setSession] = useState<string | undefined>("existing");
  const [sequence, setSequence] = useState(0);
  const [active, setActive] = useState(true);
  const [draft, setDraft] = useState<
    (ChatAgentDraftRequest & { scope: string }) | null
  >(null);
  const scope = sessionId ?? `new:${sequence}`;
  const composer = useChatComposerDraft(scope, identity);
  const startDraft = (...[text, resources]: Parameters<StartAgentChat>) => {
    const target = { id: sequence + 1, scope: `new:${sequence + 1}` };
    setSequence(sequence + 1);
    setDraft({ ...target, text, resources });
    return target;
  };
  const handoff = useWebChatDraftHandoff({
    active,
    scope,
    sessionId,
    resources: composer.resources,
    startDraft,
  });
  return (
    <>
      <button onClick={() => setSession(undefined)}>
        Finish opening new draft
      </button>
      <button onClick={() => setSession("existing")}>Open previous Chat</button>
      <button onClick={() => { setSession("another"); setDraft(null); }}>Interrupt with another Chat</button>
      <button onClick={() => setActive(false)}>Leave Chat</button>
      <button onClick={() => setActive(true)}>Return to Chat</button>
      <ChatInput
        key={scope}
        scope={scope}
        composer={composer}
        permissionMode="supervised"
        connected
        busy={false}
        attachmentsEnabled={false}
        onSubmit={submit}
        draftRequest={!sessionId && draft?.scope === scope ? draft : null}
        onDraftConsumed={(id) => {
          handoff.acknowledge(id);
          setDraft(null);
        }}
      />
    </>
  );
}
it("an already mounted Web composer receives memory only in the intended new draft", async () => {
  render(<MountedChat />);
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "Keep this old draft" } });
  act(() =>
    useCompanyDriveChatDraft.getState().openMemory([reference], identity),
  );
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
    "Keep this old draft",
  );
  expect(screen.queryByTitle("Private original")).toBeNull();
  expect(useCompanyDriveChatDraft.getState().request).not.toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Finish opening new draft" }),
  );
  await screen.findByTitle("Private original");
  await waitFor(() =>
    expect(useCompanyDriveChatDraft.getState().request).toBeNull(),
  );
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  fireEvent.click(screen.getByRole("button", { name: "Open previous Chat" }));
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
    "Keep this old draft",
  );
  expect(screen.queryByTitle("Private original")).toBeNull();
});

it("retries an interrupted handoff into a real composer without sending or changing the other draft", async () => {
  render(<MountedChat />);
  act(() => useCompanyDriveChatDraft.getState().openMemory([reference], identity));
  fireEvent.click(screen.getByRole("button", { name: "Interrupt with another Chat" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Another private draft" } });
  expect(screen.queryByTitle("Private original")).toBeNull();
  expect(useCompanyDriveChatDraft.getState().request).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Leave Chat" }));
  fireEvent.click(screen.getByRole("button", { name: "Return to Chat" }));
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Another private draft");
  fireEvent.click(screen.getByRole("button", { name: "Finish opening new draft" }));
  await screen.findByTitle("Private original");
  await waitFor(() => expect(useCompanyDriveChatDraft.getState().request).toBeNull());
  expect(submit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Interrupt with another Chat" }));
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Another private draft");
});
