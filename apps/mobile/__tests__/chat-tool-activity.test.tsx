import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react-native";

import { ChatToolActivity, ChatToolCallLine } from "../components/ChatToolActivity";
import { Icon } from "../components/ui/Icon";
import { CheckIcon, CloseIcon, LoadingIcon, StopIcon } from "../components/ui/icons";
import type { TranscriptActivity, TranscriptActivityState } from "../lib/canonical-chat-transcript";

import { flat } from "./ui-test-utils";

function step(state: TranscriptActivityState, overrides: Partial<TranscriptActivity> = {}): TranscriptActivity {
  return { id: `step_${state}`, kind: "tool", state, label: "Created the app", ...overrides };
}

function stepIcon() {
  return screen.UNSAFE_getByType(Icon).props;
}

afterEach(cleanup);

it("expands and collapses bounded command results", () => {
  render(<ChatToolActivity activity={{ id: "tool_tests", kind: "command", state: "completed", label: "Run command", preview: "bun run test", previewKind: "command", detail: "Working directory: projects/demo\n\n12 tests passed" }} />);
  expect(screen.queryByText(/12 tests passed/)).toBeNull();
  const button = screen.getByRole("button", { name: "Run command: bun run test" });
  fireEvent.press(button);
  expect(screen.getByText(/12 tests passed/)).toBeTruthy();
  fireEvent.press(button);
  expect(screen.queryByText(/12 tests passed/)).toBeNull();
});

it("shows child status and attributed results using the shared presentation", () => {
  render(<ChatToolActivity activity={{ id: "child", kind: "delegation", state: "completed", label: "Research", subagent: {
    agentId: "agent_child", parentAgentId: "agent_parent", name: "Research", status: "completed", result: "Checked the tests",
  } }} />);
  fireEvent.press(screen.getByRole("button", { name: "Research · Completed" }));
  expect(screen.getByText("Checked the tests")).toBeTruthy();
  expect(screen.getByText(/Parent agent/)).toBeTruthy();
});

describe("step line", () => {
  it("lays out a 14pt icon, 8pt, then the label", () => {
    render(<ChatToolActivity activity={step("completed")} />);

    expect(flat(screen.getByRole("button", { name: "Created the app" }))).toMatchObject({
      flexDirection: "row",
      gap: 8,
    });
    expect(stepIcon().size).toBe(14);
    expect(flat(screen.getByText("Created the app")).flexShrink).toBe(1);
  });

  it("marks a finished step with a success check and a subtle 13pt label", () => {
    render(<ChatToolActivity activity={step("completed")} />);

    expect(stepIcon()).toMatchObject({ icon: CheckIcon, color: "#288A5B" });
    expect(flat(screen.getByText("Created the app"))).toMatchObject({
      fontFamily: "Geist_400Regular",
      fontSize: 13,
      lineHeight: 18,
      color: "#635F5F",
    });
  });

  it("marks a running step with a subtle loader and a medium label in the text colour", () => {
    render(<ChatToolActivity activity={step("running", { label: "Adding the weekly view…" })} />);

    expect(stepIcon()).toMatchObject({ icon: LoadingIcon, color: "#635F5F" });
    expect(flat(screen.getByText("Adding the weekly view…"))).toMatchObject({
      fontFamily: "Geist_500Medium",
      fontSize: 13,
      lineHeight: 18,
      color: "#242323",
    });
  });

  it("marks a failed step with a danger cross", () => {
    render(<ChatToolActivity activity={step("failed")} />);

    expect(stepIcon()).toMatchObject({ icon: CloseIcon, color: "#BA5236" });
  });

  it.each<[TranscriptActivityState, unknown]>([
    ["stopped", StopIcon],
    ["partial", CheckIcon],
  ])("tints a %s step no further than the subtle text colour", (state, icon) => {
    render(<ChatToolActivity activity={step(state)} />);

    expect(stepIcon()).toMatchObject({ icon, color: "#635F5F" });
    expect(flat(screen.getByText("Created the app")).color).toBe("#635F5F");
  });

  it("is not pressable without a detail to open", () => {
    render(<ChatToolActivity activity={step("completed")} />);

    expect(screen.getByRole("button", { name: "Created the app" }).props.accessibilityState).toMatchObject({
      disabled: true,
      expanded: false,
    });
  });

  it("lists a tool call that has no state as a label in the same column, without an icon", () => {
    render(<ChatToolCallLine label="Read the current app" />);

    expect(screen.UNSAFE_queryByType(Icon)).toBeNull();
    expect(flat(screen.getByText("Read the current app"))).toMatchObject({ fontSize: 13, color: "#635F5F" });
    expect(flat(screen.getByTestId("chat-tool-call-line"))).toMatchObject({ flexDirection: "row", gap: 8 });
  });
});
