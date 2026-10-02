// @vitest-environment jsdom
import { readFile } from "node:fs/promises";
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SafeVoiceError, VoiceCapability } from "@matrix-os/contracts/voice-session";
import { AoedePanel, type AoedePanelProps } from "../../packages/ui/src/aoede/AoedePanel";
import { AoedeSettingsIcon } from "../../packages/ui/src/aoede/icons";
import {
  AOEDE_CAPTION_LIMIT, aoedeErrorCopy, boundedAoedeText, aoedeReadinessCopy, aoedeActionCopy,
} from "../../packages/ui/src/aoede/presentation";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const capability: VoiceCapability = {
  contractVersion: 1, status: "available", surface: "web_canvas",
  transportModes: ["relayed_websocket"], turnModes: ["hands_free", "push_to_talk"],
  supportsInterruption: true, resume: "delivery_aware", sessionOnly: "unsupported",
  actionMode: "conversation_only", actionCancellation: "none",
  supportsInputSelection: false, supportsOutputSelection: false,
};
const labels = {
  idle: "Ready", permission: "Waiting for microphone", connecting: "Connecting", restoring: "Restoring",
  listening: "Listening", thinking: "Thinking", using_tool: "Using tool", speaking: "Speaking",
  paused: "Paused", reconnecting: "Reconnecting", ending: "Ending", failed: "Failed", ended: "Ended",
} as const;

function setup(overrides: Partial<AoedePanelProps> = {}) {
  const commands = {
    start: vi.fn(), dismiss: vi.fn(), end: vi.fn(), pause: vi.fn(), resume: vi.fn(),
    stopSpeaking: vi.fn(), cancelGeneration: vi.fn(), pushToTalkStart: vi.fn(),
    pushToTalkStop: vi.fn(), retry: vi.fn(), newConversation: vi.fn(), viewHistory: vi.fn(),
  };
  const props: AoedePanelProps = {
    scopeLabel: "Workspace: Observatory", status: "idle", microphoneActive: false,
    turnMode: "hands_free", captions: {}, capability, commands, ...overrides,
  };
  return { ...render(<AoedePanel {...props} />), commands, props };
}

describe("AoedePanel standalone presentation", () => {
  it("shows terminal readiness failure rather than an ongoing check after timeout", () => {
    setup({ status: "failed", capability: undefined,
      error: { code: "connection_failed", retryable: true, recovery: "retry_connection" } });
    expect(screen.queryByText("Checking voice readiness")).not.toBeInTheDocument();
    expect(screen.getByText("Voice readiness check failed. Retry to check again.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
  });
  it("has no Chat chrome, composer, message list, modal trap, or automatic start", () => {
    const { container, commands } = setup();
    expect(screen.getByRole("region", { name: "Aoede" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Aoede" })).toBeVisible();
    expect(screen.getByText("Workspace: Observatory")).toBeVisible();
    expect(screen.getByText("Microphone off")).toBeVisible();
    expect(screen.getByText(/Start turns on the microphone/)).toBeVisible();
    expect(container.querySelector("textarea, input, [contenteditable], [role='log'], [role='dialog'], [aria-modal]")).toBeNull();
    expect(screen.queryByText(/Continue in Chat|Voice in Chat/)).not.toBeInTheDocument();
    expect(commands.start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(commands.start).toHaveBeenCalledTimes(1);
  });

  it.each(Object.entries(labels))("renders %s literally rather than inferring status", (status, label) => {
    setup({ status: status as AoedePanelProps["status"] });
    expect(screen.getByRole("status")).toHaveTextContent(label);
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
    expect(screen.getByRole("status")).toHaveAttribute("aria-atomic", "true");
    expect(screen.getByTestId("aoede-orb")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("Microphone off")).toBeVisible();
  });

  it.each([
    ["thinking", {}],
    ["using_tool", {}],
    ["listening", { utterance: "Draft words", provisional: true }],
  ] as const)("shows Chat-style working dots during %s work", (status, captions) => {
    setup({ status, captions });
    const dots = screen.getByTestId("aoede-working-indicator");
    expect(dots).toHaveAttribute("aria-hidden", "true");
    expect(dots.children).toHaveLength(3);
  });

  it.each(["idle", "listening", "speaking", "paused"] as const)("does not show working dots while %s", (status) => {
    setup({ status });
    expect(screen.queryByTestId("aoede-working-indicator")).not.toBeInTheDocument();
  });

  it("suppresses working-dot animation while an approval decision is required", async () => {
    setup({ status: "thinking", children: <section aria-label="Action approval"><div role="group" aria-label="Approval decision">Approve</div></section> });
    expect(screen.getByTestId("aoede-working-indicator")).toBeInTheDocument();
    const css = await readFile(`${process.cwd()}/packages/ui/src/aoede/aoede-panel.css`, "utf8");
    expect(css).toMatch(/:has\(\[aria-label="Approval decision"\]\)[^{]*matrix-aoede__working-dots\s*{[^}]*display:\s*none/);
  });

  it("starts with one gesture: no interstitial confirmation and no second button", () => {
    const view = setup();
    const start = screen.getByRole("button", { name: "Start" });
    expect(start).toHaveAccessibleDescription(/Start turns on the microphone/);
    fireEvent.click(start);
    expect(view.commands.start).toHaveBeenCalledOnce();
    view.rerender(<AoedePanel {...view.props} status="connecting" />);
    expect(screen.queryByRole("button", { name: /Allow microphone|Start/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Start turns on the microphone/)).not.toBeInTheDocument();
    expect(view.commands.start).toHaveBeenCalledOnce();
  });

  it.each([
    undefined,
    { ...capability, status: "unavailable" as const },
    { ...capability, turnModes: [] },
  ])("does not start with unavailable capability or turn mode (%#)", (readiness) => {
    const view = setup({ status: "idle", capability: readiness });
    const start = screen.getByRole("button", { name: "Start" });
    expect(start).toBeDisabled();
    fireEvent.click(start);
    expect(view.commands.start).not.toHaveBeenCalled();
  });

  it("drives the orb level from the capture feed only while listening with the microphone on, without re-rendering", () => {
    const listeners = new Set<(level: number) => void>();
    const unsubscribe = vi.fn(() => undefined);
    const subscribeInputLevel = vi.fn((listener: (level: number) => void) => { listeners.add(listener); return () => { listeners.delete(listener); unsubscribe(); }; });
    const view = setup({ status: "listening", microphoneActive: false, subscribeInputLevel });
    expect(subscribeInputLevel).not.toHaveBeenCalled();
    view.rerender(<AoedePanel {...view.props} microphoneActive subscribeInputLevel={subscribeInputLevel} />);
    expect(subscribeInputLevel).toHaveBeenCalledOnce();
    const orb = screen.getByTestId("aoede-orb");
    for (const listener of listeners) listener(0.09);
    // sqrt(0.09) * 1.8 = 0.54: a quiet voice is clearly visible, not a sliver.
    expect(orb.style.getPropertyValue("--aoede-level")).toBe("0.540");
    for (const listener of listeners) listener(0);
    // Release is soft: one silent frame does not snap the orb shut.
    expect(Number(orb.style.getPropertyValue("--aoede-level"))).toBeCloseTo(0.389, 2);
    view.rerender(<AoedePanel {...view.props} status="thinking" microphoneActive={false} subscribeInputLevel={subscribeInputLevel} />);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(orb.style.getPropertyValue("--aoede-level")).toBe("0");
  });

  it("takes microphone truth independently of status and announces scope", () => {
    setup({ status: "thinking", microphoneActive: true, title: "Workspace assistant" });
    expect(screen.getByRole("region", { name: "Workspace assistant" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Microphone active");
    expect(screen.getByRole("status")).toHaveTextContent("Workspace: Observatory");
  });

  it("keeps playback, whole-run cancellation, pause, end, and dismissal separate", () => {
    const { commands } = setup({ status: "speaking", canCancel: true });
    fireEvent.click(screen.getByRole("button", { name: "Stop speaking" }));
    expect(commands.stopSpeaking).toHaveBeenCalledTimes(1);
    expect(commands.cancelGeneration).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel generation" }));
    expect(commands.cancelGeneration).toHaveBeenCalledTimes(1);
    expect(commands.end).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(commands.pause).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "End" }));
    expect(commands.end).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss Aoede" }));
    expect(commands.dismiss).toHaveBeenCalledTimes(1);
  });

  it("does not invent task cancellation when no whole-run command is qualified", () => {
    const view = setup({ status: "using_tool" });
    view.rerender(<AoedePanel {...view.props} commands={{ ...view.commands, cancelGeneration: undefined }} />);
    expect(screen.queryByRole("button", { name: /Cancel/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pause" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Stop speaking" })).not.toBeInTheDocument();
  });

  it("hides the fallback cancel unless the snapshot qualifies it, and never duplicates the card", () => {
    // Omitted canCancel fails closed — the affordance must not appear.
    const view = setup({ status: "using_tool" });
    expect(screen.queryByRole("button", { name: "Cancel generation" })).not.toBeInTheDocument();
    // Qualified + card-free panel → built-in fallback shows.
    view.rerender(<AoedePanel {...view.props} canCancel={true} />);
    expect(screen.getByRole("button", { name: "Cancel generation" })).toBeVisible();
    // Canonical children present → the CancellationCard owns the affordance.
    view.rerender(<AoedePanel {...view.props} canCancel={true}><div>canonical</div></AoedePanel>);
    expect(screen.queryByRole("button", { name: "Cancel generation" })).not.toBeInTheDocument();
  });

  it("resumes paused sessions and explicitly continues ended sessions", () => {
    const view = setup({ status: "paused" });
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(view.commands.resume).toHaveBeenCalledTimes(1);
    view.rerender(<AoedePanel {...view.props} status="ended" />);
    expect(view.commands.start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(view.commands.start).toHaveBeenCalledTimes(1);
    // A session that has not started has nothing to end; the control is absent rather than disabled.
    expect(screen.queryByRole("button", { name: "End" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    expect(view.commands.newConversation).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "View history" }));
    expect(view.commands.viewHistory).toHaveBeenCalledTimes(1);
  });

  it("shows safe bounded readiness and never starts unavailable or unverified capability", () => {
    const view = setup({ capability: { ...capability, status: "unavailable", reason: "provider_unavailable" } });
    expect(screen.getByText("Voice unavailable. Try again later.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(view.commands.start).not.toHaveBeenCalled();
    view.rerender(<AoedePanel {...view.props} capability={undefined} />);
    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
    expect(screen.getByText("Checking voice readiness")).toBeVisible();
  });

  it.each([
    ["policy_disabled", "Review voice policy in settings."],
    ["not_configured", "Configure speech and a model in settings."],
    ["limit_reached", "Review usage in settings before trying again."],
    ["surface_unsupported", "Use a supported surface."],
    ["provider_unavailable", "Try again later."],
  ] as const)("offers allowlisted readiness directions for %s", (reason, direction) => {
    const view = setup({ capability: { ...capability, status: "unavailable", reason } });
    expect(screen.getByText(`Voice unavailable. ${direction}`)).toBeVisible();
    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
    expect(view.commands.start).not.toHaveBeenCalled();
    view.rerender(<AoedePanel {...view.props} capability={{ ...capability, status: "degraded", reason }} />);
    expect(screen.getByText(`Voice available with limits. ${direction}`)).toBeVisible();
  });

  it("never renders unknown, oversized or inherited readiness reasons or raw upstream details", () => {
    const view = setup();
    for (const reason of ["constructor", "__proto__", "postgres /home/private OpenAI", "x".repeat(10000)]) {
      const unsafe = { ...capability, status: "unavailable", reason, message: "fixture upstream detail" } as unknown as VoiceCapability;
      view.rerender(<AoedePanel {...view.props} capability={unsafe} />);
      expect(screen.getByText("Voice unavailable")).toBeVisible();
      expect(aoedeReadinessCopy(unsafe)).toBe("Voice unavailable");
      expect(screen.queryByText(/postgres|OpenAI|fixture upstream detail|constructor|__proto__/)).not.toBeInTheDocument();
    }
    expect(aoedeReadinessCopy({ ...capability, reason: "policy_disabled" })).toBe("Voice ready");
  });

  it("bounds current captions in the DOM, discloses provisional text, and replaces rather than appends", () => {
    const view = setup({ captions: { utterance: "u".repeat(10000), response: "r".repeat(10000), provisional: true } });
    const utterance = screen.getByRole("region", { name: "Current utterance (provisional)" });
    const response = screen.getByRole("region", { name: "Current response" });
    expect(utterance.querySelector("p")!.textContent!.length).toBeLessThanOrEqual(AOEDE_CAPTION_LIMIT);
    expect(response.querySelector("p")!.textContent!.length).toBeLessThanOrEqual(AOEDE_CAPTION_LIMIT);
    expect(utterance).toHaveTextContent("Provisional");
    view.rerender(<AoedePanel {...view.props} captions={{ utterance: "A new turn" }} />);
    expect(screen.queryByRole("region", { name: "Current response" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Current utterance" })).toHaveTextContent("A new turn");
  });

  it("composes canonical approval, input, progress, and result slots without a second action model", () => {
    setup({ children: <><button>Approve exact action</button><label>Clarification<input maxLength={200} /></label><p>Task running</p><a href="#result">Open result</a></> });
    expect(screen.getByRole("button", { name: "Approve exact action" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Clarification" })).toHaveAttribute("maxlength", "200");
    expect(screen.getByText("Task running")).toBeVisible();
    expect(screen.getByRole("link", { name: "Open result" })).toBeVisible();
  });

  it("keeps settings hidden until explicit disclosure and supports toggling closed", () => {
    setup({ settings: <label>Input device<select><option>System default</option></select></label> });
    const button = screen.getByRole("button", { name: "Settings" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("combobox", { name: "Input device" })).toBeVisible();
    fireEvent.click(button);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("maps error codes to allowlisted copy and never displays unknown or oversized upstream data", () => {
    const error = { code: "permission_denied", retryable: true, recovery: "request_permission", message: "postgres /home/private OpenAI token secret" } as SafeVoiceError;
    const view = setup({ status: "failed", error });
    expect(screen.getByRole("alert")).toHaveTextContent("Microphone permission is needed");
    expect(screen.getByRole("alert").textContent!.length).toBeLessThanOrEqual(200);
    expect(screen.queryByText(/postgres|OpenAI|secret/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(view.commands.retry).toHaveBeenCalledTimes(1);
    view.rerender(<AoedePanel {...view.props} error={{ ...error, code: "x".repeat(10000) } as unknown as SafeVoiceError} />);
    expect(screen.getByRole("alert")).toHaveTextContent("The request could not be completed");
    expect(screen.getByRole("alert").textContent!.length).toBeLessThanOrEqual(200);
    expect(aoedeErrorCopy("__proto__")).toBe(aoedeErrorCopy("internal_failure"));
    expect(aoedeErrorCopy("constructor")).toBe(aoedeErrorCopy("internal_failure"));
  });

  it("requires explicit New after conversation access loss, with no compulsory Chat navigation", () => {
    const view = setup({ status: "failed", error: { code: "chat_unavailable", retryable: false, recovery: "continue_in_chat" } });
    expect(screen.getByRole("alert")).toHaveTextContent("conversation is unavailable");
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue in Chat" })).not.toBeInTheDocument();
    expect(view.commands.newConversation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    expect(view.commands.newConversation).toHaveBeenCalledTimes(1);
  });
});

describe("AoedePanel push-to-talk", () => {
  beforeEach(() => {
    // jsdom lacks PointerEvent; preserve pointer identity/button values rather than testing undefined IDs.
    class TestPointerEvent extends MouseEvent {
      readonly pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 0;
      }
    }
    vi.stubGlobal("PointerEvent", TestPointerEvent);
  });

  it("ignores secondary pointers/right clicks and releases the original pointer outside the button", () => {
    const { commands } = setup({ status: "listening", turnMode: "push_to_talk" });
    const button = screen.getByRole("button", { name: "Push to talk" });
    const capture = vi.fn();
    Object.defineProperty(button, "setPointerCapture", { value: capture });
    fireEvent.pointerDown(button, { button: 2, pointerId: 1 });
    expect(commands.pushToTalkStart).not.toHaveBeenCalled();
    fireEvent.pointerDown(button, { button: 0, pointerId: 1 });
    fireEvent.pointerDown(button, { button: 0, pointerId: 2 });
    expect(capture).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledWith(1);
    fireEvent.pointerUp(window, { pointerId: 2 });
    expect(commands.pushToTalkStop).not.toHaveBeenCalled();
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(commands.pushToTalkStart).toHaveBeenCalledOnce();
    expect(commands.pushToTalkStop).toHaveBeenCalledOnce();
    // The mouse click after a completed hold must not re-start capture.
    fireEvent.click(button, { detail: 1 });
    expect(commands.pushToTalkStart).toHaveBeenCalledOnce();
  });

  it("supports assistive clicks and Escape release without starting from unrelated keys", () => {
    const { commands } = setup({ status: "listening", turnMode: "push_to_talk" });
    const button = screen.getByRole("button", { name: "Push to talk" });
    fireEvent.keyDown(button, { key: "a" });
    expect(commands.pushToTalkStart).not.toHaveBeenCalled();
    fireEvent.click(button, { detail: 0 });
    expect(button).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(button, { key: "Escape" });
    expect(button).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(button, { detail: 0 });
    fireEvent.click(button, { detail: 0 });
    expect(commands.pushToTalkStart).toHaveBeenCalledTimes(2);
    expect(commands.pushToTalkStop).toHaveBeenCalledTimes(2);
  });

  it("pairs release with the original command on capability loss or callback replacement", () => {
    const view = setup({ status: "listening", turnMode: "push_to_talk" });
    fireEvent.keyDown(screen.getByRole("button", { name: "Push to talk" }), { key: " " });
    const replacementStop = vi.fn();
    view.rerender(<AoedePanel {...view.props} capability={{ ...capability, status: "unavailable" }}
      commands={{ ...view.commands, pushToTalkStop: replacementStop }} />);
    expect(view.commands.pushToTalkStop).toHaveBeenCalledOnce();
    expect(replacementStop).not.toHaveBeenCalled();
  });

  it.each([" ", "Enter"])("holds %s without auto-repeat and releases exactly once", (key) => {
    const { commands } = setup({ status: "listening", turnMode: "push_to_talk" });
    const button = screen.getByRole("button", { name: "Push to talk" });
    fireEvent.keyDown(button, { key });
    fireEvent.keyDown(button, { key, repeat: true });
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(commands.pushToTalkStart).toHaveBeenCalledTimes(1);
    fireEvent.keyUp(button, { key: "a" });
    expect(commands.pushToTalkStop).not.toHaveBeenCalled();
    fireEvent.keyUp(button, { key });
    fireEvent.keyUp(button, { key });
    expect(commands.pushToTalkStop).toHaveBeenCalledTimes(1);
    expect(button).toHaveAttribute("aria-pressed", "false");
  });

  it("releases pointer holds on release, cancellation and lost capture without duplicate stops", () => {
    const { commands } = setup({ status: "listening", turnMode: "push_to_talk" });
    const button = screen.getByRole("button", { name: "Push to talk" });
    for (const release of ["pointerUp", "pointerCancel", "lostPointerCapture"] as const) {
      fireEvent.pointerDown(button, { button: 0, pointerId: 1 });
      fireEvent[release](button, { pointerId: 1 });
      fireEvent.pointerUp(button, { pointerId: 1 });
    }
    expect(commands.pushToTalkStart).toHaveBeenCalledTimes(3);
    expect(commands.pushToTalkStop).toHaveBeenCalledTimes(3);
  });

  it("releases on button/window blur, visibility loss, status change, and unmount", () => {
    const view = setup({ status: "listening", turnMode: "push_to_talk" });
    const button = screen.getByRole("button", { name: "Push to talk" });
    fireEvent.keyDown(button, { key: " " });
    fireEvent.blur(button);
    fireEvent.keyDown(button, { key: " " });
    fireEvent(window, new Event("blur"));
    fireEvent.keyDown(button, { key: " " });
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    fireEvent(document, new Event("visibilitychange"));
    hidden.mockRestore();
    fireEvent.keyDown(button, { key: " " });
    view.rerender(<AoedePanel {...view.props} status="paused" />);
    view.rerender(<AoedePanel {...view.props} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Push to talk" }), { key: " " });
    view.unmount();
    expect(view.commands.pushToTalkStart).toHaveBeenCalledTimes(5);
    expect(view.commands.pushToTalkStop).toHaveBeenCalledTimes(5);
  });

  it("does not capture before explicit Start or while paused, and dismissal releases before command", () => {
    const view = setup({ turnMode: "push_to_talk" });
    expect(screen.queryByRole("button", { name: "Push to talk" })).not.toBeInTheDocument();
    view.rerender(<AoedePanel {...view.props} status="listening" />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Push to talk" }), { key: " " });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss Aoede" }));
    expect(view.commands.pushToTalkStop).toHaveBeenCalledTimes(1);
    expect(view.commands.pushToTalkStop.mock.invocationCallOrder[0]).toBeLessThan(view.commands.dismiss.mock.invocationCallOrder[0]);
    view.rerender(<AoedePanel {...view.props} status="paused" />);
    expect(screen.queryByRole("button", { name: "Push to talk" })).not.toBeInTheDocument();
  });
});

describe("Aoede pure presentation helpers", () => {
  it("caps surrogate-safe captions and handles whitespace/empty content", () => {
    expect(boundedAoedeText(undefined)).toBe("");
    expect(boundedAoedeText("  ")).toBe("");
    expect(boundedAoedeText("  hello  ")).toBe("hello");
    expect(boundedAoedeText("abc\uD840\uDC00def", 5)).toBe("abc…");
    expect(boundedAoedeText("abc\uD840\uDC00def", 6)).toBe("abc\uD840\uDC00…");
  });

  it.each([
    "permission_denied", "input_unavailable", "output_unavailable", "connection_failed",
    "connection_lost", "provider_unavailable", "session_limit_reached", "usage_limit_reached",
    "audio_backpressure", "chat_unavailable", "session_conflict", "unsupported_surface", "internal_failure",
  ])("returns bounded provider-free copy for %s", (code) => {
    const copy = aoedeErrorCopy(code);
    expect(copy.length).toBeGreaterThan(0);
    expect(copy.length).toBeLessThanOrEqual(200);
    expect(copy).not.toMatch(/Continue in Chat|OpenAI|Anthropic|postgres|\/home\//i);
  });

  it("renders only allowlisted capability descriptions, not reasons or provider details", () => {
    expect(aoedeReadinessCopy()).toBe("Checking voice readiness");
    expect(aoedeReadinessCopy({ ...capability, status: "degraded" })).toBe("Voice available with limits");
    expect(aoedeActionCopy()).toBe("");
    expect(aoedeActionCopy({ ...capability, status: "unavailable" })).toBe("");
    expect(aoedeActionCopy({ ...capability, actionMode: "safe_reads" })).toBe("Qualified reads only");
    expect(aoedeActionCopy({ ...capability, actionMode: "canonical_actions" })).toBe("Individually qualified actions");
    expect(aoedeActionCopy({ ...capability, actionMode: "constructor" } as unknown as VoiceCapability)).toBe("");
  });
});

describe("AoedePanel accessibility styling", () => {
  it("renders Settings as a gear rather than a sun with detached rays", () => {
    const { container } = render(<AoedeSettingsIcon />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("data-icon", "settings-gear");
    expect(svg?.querySelectorAll("path")).toHaveLength(1);
    expect(svg?.querySelectorAll("circle")).toHaveLength(1);
  });

  it("uses theme/font tokens, visible focus, reduced motion, forced colors, and reflow instead of fixed viewport chrome", async () => {
    const css = await readFile(`${process.cwd()}/packages/ui/src/aoede/aoede-panel.css`, "utf8");
    expect(css).toContain("var(--matrix-font-sans)");
    expect(css).toContain("--aoede-surface: var(--bg-surface, var(--matrix-card))");
    expect(css).toContain("--aoede-control: var(--bg-sunken, var(--matrix-secondary))");
    expect(css).toContain("--aoede-hover: var(--bg-hover, var(--matrix-muted))");
    expect(css).toContain("--aoede-text: var(--text-primary, var(--matrix-card-fg))");
    expect(css).toContain("--aoede-muted: var(--text-secondary, var(--matrix-muted-fg))");
    expect(css).toContain("--aoede-border: var(--border-default, var(--matrix-border))");
    expect(css).toContain(":focus-visible");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    // State selectors have higher specificity; reduction must actually win the cascade.
    expect(css).toMatch(/prefers-reduced-motion:[\s\S]*animation:\s*none\s*!important/);
    expect(css).toContain("@media (forced-colors: active)");
    expect(css).toContain("flex-wrap: wrap");
    expect(css).toContain("overflow-wrap: anywhere");
    expect(css).not.toMatch(/transition:\s*all|position:\s*fixed|#[0-9a-f]{3,8}\b/i);
  });
});
