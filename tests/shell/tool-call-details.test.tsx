// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ToolCallGroup } from "../../shell/src/components/ToolCallGroup";
afterEach(cleanup);

it("shows the full command and result when a single canonical tool expands", () => {
  render(<ToolCallGroup tools={[{ id: "tool_test", role: "system", content: "Used Run command", timestamp: 0, tool: "Run command", toolDisplay: { id: "tool_test", kind: "command", state: "failed", label: "Run command", preview: "bun run test", previewKind: "command", detail: "Working directory: projects/demo\n\n1 test failed" } }]} />);
  expect(screen.getByText("bun run test")).toBeTruthy();
  fireEvent.click(screen.getByRole("button"));
  expect(screen.getByText(/1 test failed/)).toBeTruthy();
  expect(screen.getAllByLabelText("Failed").length).toBeGreaterThan(0);
});
