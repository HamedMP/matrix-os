// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RoutineFullAccessStatusSchema } from "@matrix-os/contracts";
import { CanonicalChatWorkspace } from "@desktop/renderer/src/features/chat/CanonicalChatWorkspace";
import { useProviderPreferences } from "@desktop/renderer/src/features/settings/provider-preferences";
import type { CanonicalChatEventSource, CanonicalChatInvalidation } from "@desktop/renderer/src/lib/canonical-chat-client";
import { useBoard } from "@desktop/renderer/src/stores/board";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import {
  canonicalChatRecord,
  createCanonicalChatWorkspaceClient as client,
  providerCatalog,
  snapshot,
} from "./canonical-chat-workspace-test-utils";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetProviderPreferences } from "./provider-preferences-test-utils";

describe("Canonical Chat composer preferences", () => {
  beforeAll(() => {
    globalThis.ResizeObserver = class implements ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() { return []; }
    };
  });

  beforeEach(() => {
    useBoard.setState(useBoard.getInitialState(), true);
    useConnection.setState(useConnection.getInitialState(), true);
    resetProviderPreferences({ hydrated: true });
    window.operator = {
      invoke: vi.fn(async () => ({ ok: true })),
      on: vi.fn(() => () => undefined),
    };
  });

  afterEach(cleanup);

  it("finishes scope revocation without applying an earlier run's selection to a newer run", async () => {
    const codex = providerCatalog.instances[0]!;
    const claude = {
      ...codex, id: "claude_fixture", driverKind: "claude_code" as const,
      models: [{ ...codex.models[0]!, id: "claude-opus-4-6", displayName: "Claude Opus 4.6" }],
      options: [{
        id: "effort", label: "Reasoning", kind: "enum" as const,
        values: [{ value: "low", label: "Low" }, { value: "high", label: "High" }],
        defaultValue: "low", placement: "composer" as const,
      }],
    };
    const selection = { instanceId: claude.id, model: claude.models[0]!.id, options: [{ id: "effort", value: "low" }] };
    const catalog = {
      ...providerCatalog,
      drivers: [{ ...providerCatalog.drivers[0]!, kind: claude.driverKind, displayName: "Claude Code" }],
      instances: [{ ...claude, defaultSelection: selection }],
    };
    const run = {
      ...snapshot.runs[0]!, selection, driverKind: claude.driverKind, instanceId: claude.id,
      interactionMode: "default", permissionMode: "full_access",
    };
    const record = {
      ...canonicalChatRecord, chat: { ...canonicalChatRecord.chat, currentSelection: selection },
      providerBinding: { ...canonicalChatRecord.providerBinding!, driverKind: claude.driverKind, instanceId: claude.id },
    };
    let detail = { record, messages: snapshot.messages, turns: snapshot.turns, runs: [run], activities: snapshot.activities };
    const routeClient = client();
    vi.mocked(routeClient.getDetail).mockImplementation(async () => detail);
    const listeners = new Set<(event: CanonicalChatInvalidation) => void>();
    const eventSource: Pick<CanonicalChatEventSource, "subscribe"> = {
      subscribe(listener) {
        listeners.add(listener);
        return { dispose: () => { listeners.delete(listener); } };
      },
    };
    const access = RoutineFullAccessStatusSchema.parse({ revision: 1, eligibility: "eligible", origin: "browser_required", challenge: null,
      consent: { scopeId: `rcfull_${"a".repeat(32)}`, expiresAt: new Date(Date.now() + 300_000).toISOString(), policyRevision: 0,
        actions: ["read", "propose", "control"], target: { botId: "bot_fixture1", chatId: "chat_destination" } } });
    let finishRevocation!: (value: typeof access) => void;
    const revoke = vi.fn((_chatId: string, _revision: number, _signal?: AbortSignal) =>
      new Promise<typeof access>((resolve) => { finishRevocation = resolve; }));
    routeClient.routineFullAccess = { read: vi.fn(async () => access), revoke, challenge: vi.fn(), decide: vi.fn() };
    render(<CanonicalChatWorkspace client={routeClient} projectId="matrix-os" initialChatId={record.chat.id}
      initialView="conversation" active catalog={catalog} eventSource={eventSource} />);

    await screen.findByRole("textbox", { name: "Reply to chat" });
    expect(screen.getByRole("button", { name: "Reasoning" }).textContent).toContain("Low");
    expect(screen.getByRole("button", { name: "Permission mode" }).textContent).toContain("Full Access");
    fireEvent.click(screen.getByRole("button", { name: "Permission mode" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Supervised" }));
    await waitFor(() => expect(revoke).toHaveBeenCalledExactlyOnceWith(record.chat.id, 1, expect.any(AbortSignal)));

    const nextSelection = { ...selection, options: [{ id: "effort", value: "high" }] };
    const nextTurn = { ...snapshot.turns[0]!, id: "cturn_fixture_second", clientRequestId: "req_fixture_second",
      inputMessageId: "msg_fixture_second", baseMessageSeq: 1 };
    const nextMessage = { ...snapshot.messages[0]!, id: nextTurn.inputMessageId, turnId: nextTurn.id, seq: 2 };
    const nextRun = { ...run, id: "run_fixture_second", turnId: nextTurn.id, historyBoundarySeq: 1, selection: nextSelection };
    detail = { ...detail, record: { ...record, chat: { ...record.chat, currentSelection: nextSelection, revision: 2 } },
      runs: [run, nextRun], turns: [...snapshot.turns, nextTurn], messages: [...snapshot.messages, nextMessage] };
    act(() => [...listeners].forEach(listener => listener({ type: "chat.full_refresh", cursor: 2 })));
    await waitFor(() => expect(screen.getByRole("button", { name: "Reasoning" }).textContent).toContain("High"));

    expect(revoke.mock.calls[0]?.[2]?.aborted).toBe(false);
    await act(async () => { finishRevocation({ ...access, revision: 2, consent: null }); });

    expect(screen.getByRole("button", { name: "Reasoning" }).textContent).toContain("High");
    expect(screen.getByRole("button", { name: "Permission mode" }).textContent).toContain("Full Access");
    expect(useProviderPreferences.getState().composerSelections[claude.id]).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "Routine CLI access" }));
    expect(screen.getByText("Routine CLI in this private Chat")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Revoke routine CLI access" })).toBeNull();
  });

  it("uses the last effort and permission choice as the default for a new Chat", async () => {
    const preferenceCatalog = {
      ...providerCatalog,
      instances: providerCatalog.instances.map((instance) => ({
        ...instance,
        options: [{
          id: "effort",
          label: "Reasoning",
          kind: "enum" as const,
          values: [
            { value: "low", label: "Low" },
            { value: "high", label: "High" },
          ],
          defaultValue: "low",
          placement: "composer" as const,
        }],
        defaultSelection: {
          instanceId: instance.id,
          model: instance.models[0]!.id,
          options: [{ id: "effort", value: "low" }],
        },
      })),
    };
    render(
      <CanonicalChatWorkspace
        client={client()}
        projectId="matrix-os"
        projectLabel="Matrix OS"
        initialChatId={snapshot.chat.id}
        initialView="conversation"
        active
        catalog={preferenceCatalog}
      />,
    );

    await screen.findByRole("textbox", { name: "Reply to chat" });
    fireEvent.click(screen.getByRole("button", { name: "Reasoning" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "High" }));
    fireEvent.click(screen.getByRole("button", { name: "Permission mode" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Full Access" }));

    expect(useProviderPreferences.getState().composerSelections.codex_fixture).toEqual({
      model: "gpt-5.6-sol",
      options: [{ id: "effort", value: "high" }],
      permissionMode: "full_access",
    });

    fireEvent.click(screen.getByRole("button", { name: "Choose model and provider" }));
    // The workspace has its own icon-only "New chat" control with the same accessible name,
    // so select the picker's by its visible label rather than by position.
    const newChat = screen.getAllByRole("button", { name: "New chat" })
      .find((button) => button.textContent === "New chat");
    expect(newChat).toBeDefined();
    fireEvent.click(newChat!);

    await screen.findByRole("textbox", { name: "Start a chat" });
    expect(screen.getByRole("button", { name: "Reasoning" }).textContent).toContain("High");
    expect(screen.getByRole("button", { name: "Permission mode" }).textContent).toContain("Full Access");
  });

  it("uses the last provider and model choice as the default for a new Chat", async () => {
    const codexInstance = providerCatalog.instances[0]!;
    const preferenceCatalog = {
      ...providerCatalog,
      drivers: [
        ...providerCatalog.drivers,
        {
          kind: "claude_code" as const,
          displayName: "Claude Code",
          adapterVersion: "1.0.0",
          capabilityClass: "coding_agent" as const,
        },
      ],
      instances: [
        codexInstance,
        {
          ...codexInstance,
          id: "claude_fixture",
          driverKind: "claude_code" as const,
          displayName: "Claude fixture",
          models: [
            {
              ...codexInstance.models[0]!,
              id: "anthropic:claude-opus-4.6",
              displayName: "Claude Opus 4.6",
            },
            {
              ...codexInstance.models[0]!,
              id: "anthropic:claude-sonnet-4.6",
              displayName: "Claude Sonnet 4.6",
            },
          ],
          defaultSelection: {
            instanceId: "claude_fixture",
            model: "anthropic:claude-opus-4.6",
          },
        },
      ],
    };
    const first = render(
      <CanonicalChatWorkspace
        client={client()}
        projectId="matrix-os"
        projectLabel="Matrix OS"
        initialView="draft"
        active
        catalog={preferenceCatalog}
      />,
    );

    await screen.findByRole("textbox", { name: "Start a chat" });
    fireEvent.click(screen.getByRole("button", { name: "Choose model and provider" }));
    // The two-pane picker lists a harness's models only once that harness is selected.
    fireEvent.click(screen.getByRole("button", { name: "Claude fixture agent, Available" }));
    const sonnetChoice = screen.getByRole("option", { name: "Claude Sonnet 4.6 via Claude fixture" });
    expect(sonnetChoice.getAttribute("aria-selected")).toBe("false");
    fireEvent.click(sonnetChoice);
    expect(screen.getByRole("button", { name: "Choose model and provider" })
      .getAttribute("data-provider-instance")).toBe("claude_fixture");
    expect(screen.getByRole("button", { name: "Choose model and provider" })
      .getAttribute("data-model")).toBe("anthropic:claude-sonnet-4.6");

    first.unmount();
    render(
      <CanonicalChatWorkspace
        client={client()}
        projectId="matrix-os"
        projectLabel="Matrix OS"
        initialView="draft"
        active
        catalog={preferenceCatalog}
      />,
    );

    await screen.findByRole("textbox", { name: "Start a chat" });
    expect(screen.getByRole("button", { name: "Choose model and provider" })
      .getAttribute("data-provider-instance")).toBe("claude_fixture");
    expect(screen.getByRole("button", { name: "Choose model and provider" })
      .getAttribute("data-model")).toBe("anthropic:claude-sonnet-4.6");
  });
});
