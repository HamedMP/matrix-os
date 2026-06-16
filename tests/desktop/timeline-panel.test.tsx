// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TimelinePanel from "../../desktop/src/renderer/src/features/workspace/TimelinePanel";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";

describe("TimelinePanel", () => {
  beforeEach(() => undefined);

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useConnection.setState({
      status: "loading",
      handle: null,
      platformHost: "",
      runtimeSlot: "primary",
      api: null,
    });
  });

  it("clears previous task events while the next task is loading", async () => {
    const get = vi.fn((path: string) => {
      if (path.includes("task-a")) {
        return Promise.resolve({
          events: [{ id: "event-a", type: "session.started", createdAt: new Date().toISOString() }],
        });
      }
      return new Promise(() => undefined);
    });
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://platform.test",
      runtimeSlot: "primary",
      api: { get, post: vi.fn(), patch: vi.fn(), delete: vi.fn(), putText: vi.fn() } as never,
    });

    const { rerender } = render(<TimelinePanel taskId="task-a" />);

    await waitFor(() => {
      expect(screen.queryByText("Session started")).not.toBeNull();
    });

    rerender(<TimelinePanel taskId="task-b" />);

    expect(screen.queryByText("Session started")).toBeNull();
    expect(screen.queryByText(/Loading activity/)).not.toBeNull();
  });
});
