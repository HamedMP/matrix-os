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
