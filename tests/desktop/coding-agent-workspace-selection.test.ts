// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  clearCodingAgentRuntimeSelection,
  useCodingAgentWorkspace,
} from "../../desktop/src/renderer/src/stores/coding-agent-workspace";

describe("clearCodingAgentRuntimeSelection", () => {
  it("resets the review focus signal when the runtime selection is cleared", () => {
    useCodingAgentWorkspace.setState({ reviewFocusRequestId: 7 });

    clearCodingAgentRuntimeSelection();

    expect(useCodingAgentWorkspace.getState().reviewFocusRequestId).toBe(0);
  });
});
