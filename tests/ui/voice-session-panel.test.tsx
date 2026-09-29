// @vitest-environment jsdom
import { readFile } from "node:fs/promises";
import path from "node:path";
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoicePanel } from "../../packages/ui/src/voice-session/VoicePanel";
import {
  VoiceSessionController,
  type VoiceSessionViewState,
} from "../../packages/ui/src/voice-session/controller";

afterEach(cleanup);

const SESSION_ID = "vs_ui";

const labels: Record<VoiceSessionViewState["state"], string> = {
  connecting: "Connecting",
  listening: "Listening",
  thinking: "Thinking",
  using_tool: "Using tool",
  speaking: "Speaking",
  paused: "Paused",
  reconnecting: "Reconnecting",
  failed: "Failed",
  ended: "Ended",
};

function setup(
  state: VoiceSessionViewState["state"],
  options: { turnMode?: "hands_free" | "push_to_talk"; errorCode?: string } = {},
) {
  const onCommand = vi.fn();
  const controller = new VoiceSessionController({
    initialEpoch: 1,
    sessionId: SESSION_ID,
    initialTurnMode: options.turnMode,
    onCommand,
  });
  controller.receive({
    contractVersion: 1,
    sessionId: SESSION_ID,
    type: "session.state",
    epoch: 1,
    sequence: 1,
    state,
  });
  if (state === "speaking") {
    controller.receive({
      contractVersion: 1,
      sessionId: SESSION_ID,
      type: "response.started",
      epoch: 1,
      sequence: 2,
      responseId: "vresp_1",
      runId: "run_1",
    });
  }
  if (state === "failed") {
    controller.receive({
      contractVersion: 1,
      sessionId: SESSION_ID,
      type: "session.error",
      epoch: 1,
      sequence: 3,
      code: options.errorCode ?? "connection_failed",
      recovery: options.errorCode === "permission_denied" ? "request_permission" : "retry_connection",
      retryable: true,
    });
  }
  render(<VoicePanel controller={controller} state={controller.getState()} />);
  return { controller, onCommand };
}

describe("VoicePanel", () => {
  it.each(Object.entries(labels))("renders the literal %s state as %s", (state, label) => {
    setup(state as VoiceSessionViewState["state"]);
    expect(screen.getByRole("heading", { name: label })).toBeVisible();
  });

  it("uses semantic live status and keeps the waveform supplementary", () => {
    setup("listening");
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("Listening");
    expect(screen.getByTestId("speech-input-waveform")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("group", { name: "Voice session controls" })).toBeVisible();
  });

  it("announces failure assertively with safe actionable recovery text", () => {
    setup("failed", { errorCode: "permission_denied" });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveAttribute("aria-live", "assertive");
    expect(alert).toHaveTextContent("Microphone permission is needed");
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Continue in Chat" })).toBeVisible();
  });

  it("shows state-specific pause, resume, interruption, retry, chat, and end controls", () => {
    const listening = setup("listening");
    fireEvent.click(screen.getByRole("button", { name: "Hold" }));
    expect(listening.onCommand).toHaveBeenCalledWith({ type: "session.pause" });
    cleanup();

    const paused = setup("paused");
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(paused.onCommand).toHaveBeenCalledWith({ type: "session.resume" });
    cleanup();

    const speaking = setup("speaking");
    fireEvent.click(screen.getByRole("button", { name: "Stop speaking" }));
    fireEvent.click(screen.getByRole("button", { name: "End" }));
    expect(speaking.onCommand.mock.calls.map(([command]) => command)).toContainEqual({
      type: "response.interrupt",
      responseId: "vresp_1",
      playedThroughMs: 0,
    });
    expect(speaking.onCommand.mock.calls.map(([command]) => command)).toContainEqual({ type: "session.end" });
    cleanup();

    const failed = setup("failed");
    fireEvent.click(screen.getByRole("button", { name: "Continue in Chat" }));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(failed.onCommand.mock.calls.map(([command]) => command)).toEqual([
      { type: "continue_in_chat" },
      { type: "session.retry" },
    ]);
  });

  it("supports pointer hold and keyboard hold for push-to-talk in command order", () => {
    const { onCommand } = setup("listening", { turnMode: "push_to_talk" });
    const button = screen.getByRole("button", { name: "Push to Talk" });
    fireEvent.pointerDown(button);
    expect(button).toHaveAttribute("aria-pressed", "true");
    fireEvent.pointerUp(button);
    fireEvent.keyDown(button, { key: " " });
    fireEvent.keyUp(button, { key: " " });
    expect(onCommand.mock.calls.map(([command]) => command)).toEqual([
      { type: "capture.start", mode: "push_to_talk" },
      { type: "capture.stop" },
      { type: "capture.start", mode: "push_to_talk" },
      { type: "capture.stop" },
    ]);
  });

  it("provides a click fallback for push-to-talk", () => {
    const { onCommand } = setup("listening", { turnMode: "push_to_talk" });
    const button = screen.getByRole("button", { name: "Push to Talk" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onCommand.mock.calls.map(([command]) => command)).toEqual([
      { type: "capture.start", mode: "push_to_talk" },
      { type: "capture.stop" },
    ]);
  });

  it("marks a bounded provisional transcript as Draft transcript", () => {
    const controller = new VoiceSessionController({ initialEpoch: 1, sessionId: SESSION_ID });
    controller.receive({
      contractVersion: 1,
      sessionId: SESSION_ID,
      type: "transcript.provisional",
      epoch: 1,
      sequence: 1,
      turnId: "vturn_1",
      revision: 1,
      text: "unfinished sentence",
    });
    render(<VoicePanel controller={controller} state={controller.getState()} />);
    expect(screen.getByRole("region", { name: "Draft transcript" })).toHaveTextContent("unfinished sentence");
    expect(screen.getByText("Draft transcript")).toBeVisible();
  });

  it("honors reduced motion, avoids transition-all, and never relies on visual activity alone", async () => {
    const css = await readFile(
      path.join(process.cwd(), "packages/ui/src/voice-session/voice-session.css"),
      "utf8",
    );
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toMatch(/prefers-reduced-motion:[\s\S]*animation:\s*none/);
    expect(css).not.toMatch(/transition:\s*all/);
    setup("using_tool");
    expect(screen.getByRole("heading", { name: "Using tool" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Using tool");
  });
});
