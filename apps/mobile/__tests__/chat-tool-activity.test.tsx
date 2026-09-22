import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { ChatToolActivity } from "../components/ChatToolActivity";

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
