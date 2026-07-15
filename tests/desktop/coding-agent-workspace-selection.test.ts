// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
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
});
