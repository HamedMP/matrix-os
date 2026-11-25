// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import {
  clearCodingAgentRuntimeSelection,
  useCodingAgentWorkspace,
} from "../../desktop/src/renderer/src/stores/coding-agent-workspace";

describe("clearCodingAgentRuntimeSelection", () => {
  it("resets the review focus signal when the runtime selection is cleared", () => {
    useCodingAgentWorkspace.setState({ reviewFocusRequestId: 7, reviewFocusConsumedId: 5 });

    clearCodingAgentRuntimeSelection();

    expect(useCodingAgentWorkspace.getState().reviewFocusRequestId).toBe(0);
    expect(useCodingAgentWorkspace.getState().reviewFocusConsumedId).toBe(0);
  });

  it("drops the previous computer's notification preferences", () => {
    useCodingAgentWorkspace.setState({
      notificationPreferencesStatus: "ready",
      notificationPreferences: {
        attentionPush: { approval: true, input: false, failed: true, completed: false },
      },
      notificationPreferencesError: null,
    });

    clearCodingAgentRuntimeSelection();

    expect(useCodingAgentWorkspace.getState()).toMatchObject({
      notificationPreferencesStatus: "idle",
      notificationPreferences: null,
      notificationPreferencesError: null,
    });
  });

  it("ignores an old computer's save response after clearing the selection", async () => {
    const initial = { attentionPush: { approval: true, input: true, failed: true, completed: true } };
    let release!: (value: unknown) => void;
    window.operator = { on: () => () => {}, invoke: vi.fn((channel: string) => {
      if (channel === "runtime:get-notification-preferences") return Promise.resolve(initial);
      return new Promise(resolve => { release = resolve; });
    }) };
    useCodingAgentWorkspace.setState({ notificationPreferences: initial, notificationPreferencesStatus: "ready" });
    const save = useCodingAgentWorkspace.getState().updateNotificationPreferences({ attentionPush: { completed: false } });
    await vi.waitFor(() => expect(window.operator.invoke).toHaveBeenCalledWith("runtime:update-notification-preferences", expect.anything()));
    clearCodingAgentRuntimeSelection();
    const next = { attentionPush: { approval: false, input: false, failed: false, completed: true } };
    useCodingAgentWorkspace.setState({ notificationPreferences: next, notificationPreferencesStatus: "ready" });
    release({ attentionPush: { ...initial.attentionPush, completed: false } });
    await save;
    expect(useCodingAgentWorkspace.getState().notificationPreferences).toEqual(next);
    clearCodingAgentRuntimeSelection();
  });
});
