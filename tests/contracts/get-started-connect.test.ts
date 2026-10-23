import { describe, expect, it } from "vitest";
import {
  GET_STARTED_TOOL_IDS,
  getStartedConnectOrder,
  getStartedToolConnect,
  getStartedToolForService,
} from "../../packages/contracts/src/index.js";

describe("get started connect step", () => {
  it("knows how every tool connects, with a valid service id for apps", () => {
    for (const tool of GET_STARTED_TOOL_IDS) {
      const connect = getStartedToolConnect(tool);
      expect(connect.why.length).toBeGreaterThan(0);
      if (connect.kind === "app") expect(connect.service).toMatch(/^[a-z0-9][a-z0-9_-]{0,63}$/);
    }
    expect(getStartedToolConnect("outlook")).toMatchObject({ kind: "app", service: "microsoft_outlook" });
    expect(getStartedToolConnect("claude-code").kind).toBe("agent");
    expect(getStartedToolConnect("whatsapp").kind).toBe("channel");
  });

  it("maps a connected service back to its tool", () => {
    expect(getStartedToolForService("linear")).toBe("linear");
    expect(getStartedToolForService("microsoft_outlook")).toBe("outlook");
    expect(getStartedToolForService("google_calendar")).toBe("google-calendar");
    expect(getStartedToolForService("twitter")).toBeUndefined();
  });

  it("puts the integrations that fit the goals first, in goal order", () => {
    expect(getStartedConnectOrder(["code"]).slice(0, 5)).toEqual(["github", "linear", "jira", "figma", "slack"]);
    expect(getStartedConnectOrder(["business", "code"]).slice(0, 3)).toEqual(["gmail", "microsoft_outlook", "google_calendar"]);
    expect(getStartedConnectOrder([])).toEqual(["gmail", "google_calendar"]);
    const order = getStartedConnectOrder(["code", "business", "assistant", "build", "explore"]);
    expect(new Set(order).size).toBe(order.length);
  });

});
