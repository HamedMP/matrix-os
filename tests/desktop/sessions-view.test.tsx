// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import SessionsView from "../../desktop/src/renderer/src/features/sessions/SessionsView";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useSessions } from "../../desktop/src/renderer/src/stores/sessions";
import { useUi } from "../../desktop/src/renderer/src/stores/ui";

describe("SessionsView", () => {
  beforeEach(() => {
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://x.test",
      runtimeSlot: "primary",
      api: null,
    });
    useSessions.setState({
      sessions: [
        {
          name: "main",
          attachName: "main",
          status: "active",
          source: "zellij",
        },
      ],
      aliasMap: { main: "main" },
      loading: false,
      error: "offline",
    });
    useUi.setState({ view: { kind: "sessions" } });
  });

  afterEach(() => {
    cleanup();
  });

  it("keeps cached sessions visible while surfacing refresh errors", () => {
    render(<SessionsView />);

    expect(screen.getByRole("alert").textContent).toContain("Can't reach Matrix OS");
    expect(screen.getByText("main")).toBeTruthy();
  });
});
