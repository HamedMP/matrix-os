import { describe, expect, it } from "vitest";
import {
  GET_STARTED_CONNECT_MAX_PICKED,
  GET_STARTED_TOOL_IDS,
  getStartedConnectPlan,
  getStartedToolConnect,
  type GetStartedAnswers,
} from "../../packages/contracts/src/index.js";

const ALL_APPS = new Set([
  "github", "linear", "jira", "figma", "gmail", "microsoft_outlook", "google_calendar",
  "slack", "notion", "stripe", "hubspot", "discord", "todoist",
]);

function answers(partial: Partial<GetStartedAnswers>): GetStartedAnswers {
  return { goals: [], tools: [], ...partial };
}

describe("get started connect plan", () => {
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

  it("lists picked tools in order, capped", () => {
    const plan = getStartedConnectPlan(
      answers({ goals: ["code"], tools: ["github", "claude-code", "linear", "jira", "figma"] }),
      ALL_APPS,
    );
    expect(plan.rows.map((row) => row.tool)).toEqual(["github", "claude-code", "linear", "jira"]);
    expect(plan.rows).toHaveLength(GET_STARTED_CONNECT_MAX_PICKED);
    expect(plan.rows[0]).toMatchObject({ label: "GitHub", service: "github", why: "So your AI can work on your repos" });
  });

  it("leaves out apps the computer cannot connect", () => {
    const plan = getStartedConnectPlan(answers({ goals: ["code"], tools: ["github", "linear"] }), new Set(["github"]));
    expect(plan.rows.map((row) => row.tool)).toEqual(["github"]);
  });

  it("suggests two available apps for the first goal that were not picked", () => {
    const plan = getStartedConnectPlan(answers({ goals: ["code", "business"], tools: ["figma"] }), ALL_APPS);
    expect(plan.suggestionTitle).toBe("Popular with developers");
    expect(plan.suggestions.map((row) => row.tool)).toEqual(["slack", "github"]);
  });

  it("suggests apps to start with when no goal was picked", () => {
    const plan = getStartedConnectPlan(answers({}), ALL_APPS);
    expect(plan.suggestionTitle).toBe("Popular to start with");
    expect(plan.suggestions.map((row) => row.service)).toEqual(["gmail", "google_calendar"]);
  });

  it("has nothing to connect when the app catalog is unavailable", () => {
    const plan = getStartedConnectPlan(answers({ goals: ["business"], tools: ["gmail"] }), new Set());
    expect(plan.rows).toEqual([]);
    expect(plan.suggestions).toEqual([]);
  });
});
