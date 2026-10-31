// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  ChatAgentsContent,
  ChatAgentsWorkspace,
  useChatAgentsNavigation,
} from "@matrix-os/ui";
import {
  NativeAppChatNavigationHost,
  useNativeAppChatNavigation,
} from "../../desktop/src/renderer/src/features/chat/native-app-chat-navigation";
import type { ChatAgentClient } from "../../packages/ui/src/chat-agents/client";
import { clientFixture } from "./chat-agents-fixture";

vi.mock("../../desktop/src/renderer/src/lib/operator", () => ({
  invoke: vi.fn(async () => ({ ok: true })),
}));

HTMLDialogElement.prototype.showModal = function showModal() { this.setAttribute("open", ""); };
HTMLDialogElement.prototype.close = function close() { this.removeAttribute("open"); };

function OpenAgentDraft({ client }: { client: ChatAgentClient }) {
  const navigation = useChatAgentsNavigation();
  return <button type="button" onClick={() => navigation?.open({ client, view: "library" })}>
    Open other window Agents
  </button>;
}

function ChatWindow({ tabId, client, withDraftControl = false }: {
  tabId: string;
  client: ChatAgentClient;
  withDraftControl?: boolean;
}) {
  return <section data-testid={`chat-window-${tabId}`}>
    <ChatAgentsWorkspace>
      <NativeAppChatNavigationHost
        active
        tabId={tabId}
        client={{ agents: client } as never}
        onStartChat={vi.fn()}
        runtimeSlot="primary"
        authGeneration={7}
      />
      {withDraftControl ? <OpenAgentDraft client={client} /> : null}
      <ChatAgentsContent client={client} scopeKey={`chat:${tabId}`}>
        <p>{tabId} Chat</p>
      </ChatAgentsContent>
    </ChatAgentsWorkspace>
  </section>;
}

afterEach(() => {
  cleanup();
  useNativeAppChatNavigation.setState(useNativeAppChatNavigation.getInitialState(), true);
});

it("opens a native recipe only in the selected Chat workspace and preserves another window's unsaved Agent draft", async () => {
  const targetClient = clientFixture({ matrix: true });
  const otherClient = clientFixture({ matrix: true });
  render(<>
    <ChatWindow tabId="other-chat" client={otherClient} withDraftControl />
    <ChatWindow tabId="target-chat" client={targetClient} />
  </>);

  const otherWindow = within(screen.getByTestId("chat-window-other-chat"));
  fireEvent.click(otherWindow.getByRole("button", { name: "Open other window Agents" }));
  fireEvent.click(await otherWindow.findByRole("button", { name: "New Agent" }));
  fireEvent.click(await otherWindow.findByRole("button", { name: "Start from scratch" }));
  fireEvent.change(otherWindow.getByRole("textbox", { name: "Name" }), {
    target: { value: "Keep this unsaved draft" },
  });
  fireEvent.change(otherWindow.getByRole("textbox", { name: "Instructions" }), {
    target: { value: "Do not discard these unsaved instructions." },
  });

  act(() => useNativeAppChatNavigation.getState().queue({
    requestId: "request-target-window",
    view: "recipes",
    runtimeSlot: "primary",
    authGeneration: 7,
  }, "target-chat"));

  const targetWindow = within(screen.getByTestId("chat-window-target-chat"));
  expect(await targetWindow.findByRole("region", { name: "Agent recipes" })).toBeTruthy();
  await waitFor(() => expect(useNativeAppChatNavigation.getState().pending).toBeNull());
  expect((otherWindow.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value)
    .toBe("Keep this unsaved draft");
  expect((otherWindow.getByRole("textbox", { name: "Instructions" }) as HTMLTextAreaElement).value)
    .toBe("Do not discard these unsaved instructions.");
});
