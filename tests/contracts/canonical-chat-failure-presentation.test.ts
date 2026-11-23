import { describe, expect, it } from "vitest";
import { canonicalAgentFailure, canonicalChatFailurePresentation } from "@matrix-os/contracts";
import { canonicalChatFailurePresentation as uiPresentation, canonicalChatRunHarnessLabel } from "@matrix-os/ui";
import { createCanonicalProviderCatalogFixture } from "./fixtures/canonical-chat";

// Owner outcome: a failed Chat run says which agent failed, why, and offers the
// action that fixes it. Faults caught: dropped recovery actions, Retry on a
// non-retryable failure, unreviewed server text, duplicate or unbounded buttons.
const signIn = "Sign-in required. Reconnect in Agents & providers on this computer.";

describe("canonicalChatFailurePresentation", () => {
  it("restores the reviewed sign-in recovery for the legacy stored Claude failure", () => {
    const presentation = canonicalChatFailurePresentation({
      code: "authorization_failed",
      safeMessage: "Claude needs to be connected before it can run. Open setup and connect Claude.",
      retryable: true,
      recoveryActions: ["retry"],
    }, { harnessLabel: "Claude" });
    expect(presentation).toEqual({
      title: "Claude could not finish",
      message: signIn,
      actions: [
        { kind: "open_setup_terminal", label: "Open Agents & providers" },
        { kind: "select_provider", label: "Choose model" },
      ],
    });
  });

  it("names no harness when the label is unknown", () => {
    expect(canonicalChatFailurePresentation(canonicalAgentFailure("model_unavailable"))).toEqual({
      title: "Agent work failed",
      message: "Model unavailable. Choose another model.",
      actions: [{ kind: "select_provider", label: "Choose model" }],
    });
    expect(canonicalChatFailurePresentation(undefined, { harnessLabel: "  " }).title).toBe("Agent work failed");
  });

  it("offers New chat for a run that cannot be resumed", () => {
    expect(canonicalChatFailurePresentation(canonicalAgentFailure("context_limit")).actions)
      .toEqual([{ kind: "start_new_chat", label: "New chat" }]);
  });

  it("keeps Retry only for retryable failures that the server allows to retry", () => {
    const transient = canonicalAgentFailure("service_busy")!;
    expect(canonicalChatFailurePresentation(transient).actions).toEqual([{ kind: "retry", label: "Retry" }]);
    expect(canonicalChatFailurePresentation(transient, { allowRetry: false }).actions).toEqual([]);
    expect(canonicalChatFailurePresentation({ ...transient, retryable: false }).actions).toEqual([]);
    expect(canonicalChatFailurePresentation({ ...transient, recoveryActions: [] }).actions).toEqual([]);
    // A reviewed non-retryable cause wins over a stale retryable wire flag.
    expect(canonicalChatFailurePresentation({
      code: "service_unavailable", safeMessage: "Claude took too long to respond. Try the Run again.",
      retryable: true, recoveryActions: ["retry"],
    }).actions).toEqual([]);
  });

  it("orders, deduplicates, folds Fork into New chat, hides Return to project and caps at three", () => {
    expect(canonicalChatFailurePresentation({
      code: "provider_instance_locked", safeMessage: "Locked.", retryable: true,
      recoveryActions: ["return_to_project", "fork_chat", "start_new_chat", "select_provider", "retry", "open_setup_terminal"],
    }).actions.map((action) => action.kind)).toEqual(["retry", "open_setup_terminal", "select_provider"]);
    expect(canonicalChatFailurePresentation({
      code: "provider_instance_locked", safeMessage: "Locked.", retryable: false,
      recoveryActions: ["fork_chat", "start_new_chat", "return_to_project"],
    }).actions).toEqual([{ kind: "start_new_chat", label: "New chat" }]);
  });

  it("unions wire actions with the reviewed catalog actions", () => {
    expect(canonicalChatFailurePresentation({
      ...canonicalAgentFailure("permission_denied")!, recoveryActions: ["start_new_chat"],
    }).actions.map((action) => action.kind)).toEqual(["open_setup_terminal", "start_new_chat"]);
  });

  it("never shows unreviewed server text and falls back to per-code copy", () => {
    const presentation = canonicalChatFailurePresentation({
      code: "provider_unavailable", safeMessage: "token=secret /home/private", retryable: false,
    }, { harnessLabel: "Hermes" });
    expect(presentation).toEqual({
      title: "Hermes could not finish",
      message: "Connection unavailable. Check Agents & providers.",
      actions: [],
    });
    expect(canonicalChatFailurePresentation(undefined).message).toBe("The agent could not finish. Try again.");
  });

  it("is the same derivation for clients importing @matrix-os/ui", () => {
    expect(uiPresentation).toBe(canonicalChatFailurePresentation);
  });
});

describe("canonicalChatRunHarnessLabel", () => {
  const catalog = createCanonicalProviderCatalogFixture();
  it("uses the picker's harness name for the run's provider instance", () => {
    expect(canonicalChatRunHarnessLabel({ instanceId: "codex_fixture", driverKind: "codex" }, catalog)).toBe("Codex fixture");
    expect(canonicalChatRunHarnessLabel({ instanceId: "matrix_pi_default", driverKind: "matrix_pi" }, {
      ...catalog, instances: [{ ...catalog.instances[0]!, id: "matrix_pi_default", driverKind: "matrix_pi", displayName: "Pi" }],
    })).toBe("Matrix AI");
  });
  it("falls back to the harness name when the instance left the catalog, never to a generic Bot", () => {
    expect(canonicalChatRunHarnessLabel({ instanceId: "removed", driverKind: "hermes" }, catalog)).toBe("Hermes");
    expect(canonicalChatRunHarnessLabel({ instanceId: "removed", driverKind: "claude_code" }, null)).toBe("Claude Code");
    expect(canonicalChatRunHarnessLabel({ instanceId: "removed", driverKind: "matrix_bot" }, catalog)).toBeUndefined();
  });
});
