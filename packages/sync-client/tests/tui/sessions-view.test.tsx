import React from "react";
import { describe, expect, it } from "vitest";
import { renderTui } from "./test-utils.js";
import { shellSessionFixtures } from "./session-fixtures.js";
import { SessionsView } from "../../src/cli/tui/views/SessionsView.js";

describe("SessionsView", () => {
  it("renders list and empty states", () => {
    const list = renderTui(<SessionsView sessions={shellSessionFixtures} selectedIndex={1} noColor />);
    expect(list).toContain("Shell Sessions");
    expect(list).toContain("> review");
    expect(list).toContain("Enter attach");

    const empty = renderTui(<SessionsView sessions={[]} state="empty" noColor />);
    expect(empty).toContain("No shell sessions yet");
  });

  it("renders unauthenticated and gateway-unavailable recovery states", () => {
    expect(renderTui(<SessionsView sessions={[]} state="unauthenticated" noColor />)).toContain("Log in to list shell sessions");
    expect(renderTui(<SessionsView sessions={[]} state="gateway-unavailable" noColor />)).toContain("Gateway unavailable");
  });
});
