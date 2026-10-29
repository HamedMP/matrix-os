// @vitest-environment jsdom
import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  requestOnboardingTask,
  useOnboardingTaskRequests,
} from "../../packages/ui/src/onboarding-widget/task-requests";

afterEach(() => cleanup());

function Listener({ onTask }: { onTask(taskId: string): void }) {
  useOnboardingTaskRequests(onTask);
  return null;
}

describe("onboarding task requests", () => {
  it("reports that nobody handled a request when no widget is mounted", () => {
    expect(requestOnboardingTask("research")).toBe(false);
  });

  it("hands a starter task to the mounted widget", () => {
    const onTask = vi.fn();
    render(<Listener onTask={onTask} />);
    expect(requestOnboardingTask("plan-week")).toBe(true);
    expect(onTask).toHaveBeenCalledWith("plan-week");
  });

  it("delivers each request to the most recent widget only", () => {
    const first = vi.fn();
    const second = vi.fn();
    render(<><Listener onTask={first} /><Listener onTask={second} /></>);
    requestOnboardingTask("build-website");
    expect(second).toHaveBeenCalledWith("build-website");
    expect(first).not.toHaveBeenCalled();
  });

  it("stops delivering once the widget unmounts", () => {
    const onTask = vi.fn();
    const { unmount } = render(<Listener onTask={onTask} />);
    unmount();
    expect(requestOnboardingTask("work-on-code")).toBe(false);
    expect(onTask).not.toHaveBeenCalled();
  });
});
