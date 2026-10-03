import { HostedChatShareSuspensionContext, useHostedChatShareSuspension } from "@desktop/renderer/src/features/chat/hosted-chat-share-suspension";
import { SurfaceChromeContext } from "@desktop/renderer/src/features/desktop-shell/SurfaceChrome";
// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CanonicalChatInvalidation } from "@desktop/renderer/src/lib/canonical-chat-client";
import type { ApiClient } from "@desktop/renderer/src/lib/api";
import { CanonicalChatWorkspace } from "@desktop/renderer/src/features/chat/CanonicalChatWorkspace";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalChatRecord, createCanonicalChatWorkspaceClient, providerCatalog, snapshot } from "./canonical-chat-workspace-test-utils";

class WorkspaceResizeObserver implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}

const maskedText = "Use token=[redacted credential] for this request.";
const secret = "private-test-value";
const assistant = {
  id: "msg_secret", chatId: snapshot.chat.id, seq: 2, role: "assistant" as const,
  state: "committed" as const, turnId: snapshot.turns[0]!.id, runId: snapshot.runs[0]!.id,
  parts: [{ type: "text" as const, text: maskedText }], createdAt: snapshot.chat.createdAt,
};
const occurrence = { id: "cred_00000000000000000000000000000001", messageId: assistant.id, offset: maskedText.indexOf("[redacted credential]"), length: 21, revealed: true };
const connectedEventSource = {
  subscribe: () => ({ dispose() {} }),
  subscribeConnectionState: () => ({ dispose() {} }),
  connectionState: () => "open" as const,
};

beforeEach(() => {
  globalThis.ResizeObserver = WorkspaceResizeObserver;
  useConnection.setState({ ...useConnection.getInitialState(), status: "signed-in", userId: "user_fixture" }, true);
});
afterEach(() => {
  cleanup();
  useConnection.setState(useConnection.getInitialState(), true);
});

describe("owner-only credential disclosure in Electron Chat", () => {
  it("keeps generic message copy masked while a rehydrated value replaces its marker, then clears it on auth loss", async () => {
    const copy = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
    const routeClient = createCanonicalChatWorkspaceClient();
    vi.mocked(routeClient.getDetail).mockResolvedValue({
      record: canonicalChatRecord, messages: [...snapshot.messages, assistant],
      turns: snapshot.turns, runs: snapshot.runs, activities: snapshot.activities,
    });
    routeClient.getCredentialOccurrences = vi.fn(async () => [occurrence]);
    routeClient.getRevealedCredential = vi.fn(async () => secret);
    routeClient.revealCredential = vi.fn(async () => secret);
    routeClient.hideCredential = vi.fn(async () => undefined);

    render(<CanonicalChatWorkspace client={routeClient} api={{} as ApiClient} projectId="matrix-os"
      initialChatId={snapshot.chat.id} initialView="conversation" active catalog={providerCatalog} eventSource={connectedEventSource} />);
    expect(await screen.findByText(secret)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hide credential 1" }).textContent).toBe(secret);
    expect(screen.queryByText("[redacted credential]", { exact: false })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Copy assistant message" }));
    await waitFor(() => expect(copy).toHaveBeenCalledWith(maskedText));
    expect(copy).not.toHaveBeenCalledWith(secret);

    act(() => { useConnection.setState({ status: "signed-out", userId: null }); });
    await waitFor(() => expect(screen.queryByText(secret)).toBeNull());
  });

  it("clears a revealed value before the hosted toolbar can commit sharing", async () => {
    const routeClient = createCanonicalChatWorkspaceClient();
    vi.mocked(routeClient.getDetail).mockResolvedValue({ record: canonicalChatRecord, messages: [...snapshot.messages, assistant],
      turns: snapshot.turns, runs: snapshot.runs, activities: snapshot.activities });
    routeClient.getCredentialOccurrences = vi.fn(async () => [occurrence]);
    routeClient.getRevealedCredential = vi.fn(async () => secret);
    routeClient.revealCredential = vi.fn(async () => secret);
    routeClient.hideCredential = vi.fn(async () => undefined);
    const posted = vi.fn();
    function Hosted() {
      const suspension = useHostedChatShareSuspension(routeClient, snapshot.chat.id, "runtime:owner");
      return <SurfaceChromeContext.Provider value={{ setChrome() {} }}>
        <button onClick={() => { suspension.start(); expect(screen.queryByText(secret)).toBeNull(); posted(); }}>Hosted live share</button>
        <HostedChatShareSuspensionContext.Provider value={suspension.report}>
          <CanonicalChatWorkspace client={routeClient} api={{} as ApiClient} projectId="matrix-os"
            initialChatId={snapshot.chat.id} initialView="conversation" active catalog={providerCatalog} eventSource={connectedEventSource}/>
        </HostedChatShareSuspensionContext.Provider>
      </SurfaceChromeContext.Provider>;
    }
    render(<Hosted/>);
    expect(await screen.findByText(secret)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hosted live share" }));
    expect(posted).toHaveBeenCalledOnce();
    expect(screen.queryByText(secret)).toBeNull();
  });

  it("clears a revealed value on a remote Chat update before delayed detail reload", async () => {
    const routeClient = createCanonicalChatWorkspaceClient();
    vi.mocked(routeClient.getDetail).mockResolvedValue({
      record: canonicalChatRecord, messages: [...snapshot.messages, assistant],
      turns: snapshot.turns, runs: snapshot.runs, activities: snapshot.activities,
    });
    routeClient.getCredentialOccurrences = vi.fn(async () => [occurrence]);
    routeClient.getRevealedCredential = vi.fn(async () => secret);
    routeClient.revealCredential = vi.fn(async () => secret);
    routeClient.hideCredential = vi.fn(async () => undefined);
    const listeners: Array<(event: CanonicalChatInvalidation) => void> = [];
    const eventSource = { subscribe: (listener: (event: CanonicalChatInvalidation) => void) => {
      listeners.push(listener);
      return { dispose() { const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1); } };
    }, subscribeConnectionState: () => ({ dispose() {} }), connectionState: () => "open" as const };

    render(<CanonicalChatWorkspace client={routeClient} api={{} as ApiClient} projectId="matrix-os"
      initialChatId={snapshot.chat.id} initialView="conversation" active catalog={providerCatalog} eventSource={eventSource} />);
    expect(await screen.findByText(secret)).toBeTruthy();
    vi.mocked(routeClient.getDetail).mockImplementation(() => new Promise(() => undefined));
    act(() => { for (const listener of [...listeners]) listener({ type: "chat.changed", chatId: snapshot.chat.id, cursor: 2, revision: 2, eventType: "chat.updated" }); });
    expect(screen.queryByText(secret)).toBeNull();
  });

  it("clears plaintext on SSE disconnect and rehydrates only after reconnection", async () => {
    const routeClient = createCanonicalChatWorkspaceClient();
    vi.mocked(routeClient.getDetail).mockResolvedValue({
      record: canonicalChatRecord, messages: [...snapshot.messages, assistant],
      turns: snapshot.turns, runs: snapshot.runs, activities: snapshot.activities,
    });
    routeClient.getCredentialOccurrences = vi.fn(async () => [occurrence]);
    routeClient.getRevealedCredential = vi.fn(async () => secret);
    routeClient.revealCredential = vi.fn(async () => secret);
    routeClient.hideCredential = vi.fn(async () => undefined);
    let connection: "open" | "reconnecting" = "open";
    let notifyConnection!: () => void;
    const eventSource = {
      subscribe: () => ({ dispose() {} }),
      subscribeConnectionState: (notify: () => void) => { notifyConnection = notify; return { dispose() {} }; },
      connectionState: () => connection,
    };
    render(<CanonicalChatWorkspace client={routeClient} api={{} as ApiClient} projectId="matrix-os"
      initialChatId={snapshot.chat.id} initialView="conversation" active catalog={providerCatalog} eventSource={eventSource} />);
    expect(await screen.findByText(secret)).toBeTruthy();
    act(() => { connection = "reconnecting"; notifyConnection(); });
    expect(screen.queryByText(secret)).toBeNull();
    act(() => { connection = "open"; notifyConnection(); });
    expect(await screen.findByText(secret)).toBeTruthy();
    expect(routeClient.getRevealedCredential).toHaveBeenCalledTimes(2);
  });
});
