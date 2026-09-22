// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ConversationActivityGroup } from "../../desktop/src/renderer/src/components/conversation/activity";
afterEach(cleanup);

it("shows every active child with attribution and expands its task and result", () => {
  render(<ConversationActivityGroup callbacks={{ copyText: async () => {} }} activities={[
    { id: "a", kind: "delegation", state: "running", label: "Research", subagent: {
      agentId: "agent_a", parentAgentId: "agent_parent", name: "Research", status: "waiting", task: "Review tests",
    } },
    { id: "b", kind: "delegation", state: "completed", label: "Build", subagent: {
      agentId: "agent_b", parentAgentId: "agent_parent", name: "Build", status: "completed", result: "Build passed",
    } },
  ]} />);
  expect(screen.getByRole("button", { name: /Research.*Waiting/ })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Research.*Waiting/ }));
  expect(screen.getByText("Review tests")).toBeTruthy();
  expect(screen.getByText(/Parent agent/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Build.*Completed/ }));
  expect(screen.getByText("Build passed")).toBeTruthy();
});
