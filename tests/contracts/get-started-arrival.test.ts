import { describe, expect, it } from "vitest";
import {
  GETTING_STARTED_STEP_IDS,
  ONBOARDING_TASK_IDS,
  getStartedStepOrder,
  getStartedTaskOrder,
  orderByIds,
  personalizeGettingStartedSteps,
  deriveGettingStartedSnapshot,
} from "../../packages/contracts/src/index.js";

describe("personalised arrival order", () => {
  it("keeps today's order without goals", () => {
    expect(getStartedStepOrder([])).toEqual([...GETTING_STARTED_STEP_IDS]);
    expect(getStartedTaskOrder([])).toEqual([...ONBOARDING_TASK_IDS]);
    expect(getStartedStepOrder(["explore"])).toEqual([...GETTING_STARTED_STEP_IDS]);
  });

  it("puts coding steps and the code task first for a coding goal", () => {
    expect(getStartedStepOrder(["code"])).toEqual(["agent", "github", "first-work", "email-calendar", "billing"]);
    expect(getStartedTaskOrder(["code"])[0]).toBe("work-on-code");
  });

  it("merges goals in the order they were picked", () => {
    expect(getStartedStepOrder(["business", "code"]).slice(0, 3)).toEqual(["email-calendar", "first-work", "agent"]);
    expect(getStartedTaskOrder(["build", "assistant"]).slice(0, 2)).toEqual(["build-website", "plan-week"]);
  });

  it("always returns every id exactly once", () => {
    for (const goals of [["code"], ["business"], ["assistant"], ["build"], ["code", "build", "business"]] as const) {
      expect([...getStartedStepOrder(goals)].sort()).toEqual([...GETTING_STARTED_STEP_IDS].sort());
      expect([...getStartedTaskOrder(goals)].sort()).toEqual([...ONBOARDING_TASK_IDS].sort());
    }
  });

  it("orders items by id and keeps unknown ids at the end", () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(orderByIds(items, ["c", "a"]).map((item) => item.id)).toEqual(["c", "a", "b"]);
  });
});

describe("personalised Getting started steps", () => {
  const steps = GETTING_STARTED_STEP_IDS.map((id) => ({ id, label: id, status: "incomplete" as const }));

  it("leads with the owner's goals and names the coding agents they picked", () => {
    const personalized = personalizeGettingStartedSteps(steps, { goals: ["code"], tools: ["codex"] });
    expect(personalized.map((step) => step.id)).toEqual(getStartedStepOrder(["code"]));
    expect(personalized[0]).toEqual({ id: "agent", label: "Log in to Codex", status: "incomplete" });
    const both = personalizeGettingStartedSteps(steps, { goals: [], tools: ["codex", "opencode", "claude-code"] });
    expect(both.find((step) => step.id === "agent")?.label).toBe("Log in to Claude Code / Codex");
  });

  it("ticks the named agent step only for an agent the owner picked", () => {
    const signedIn = steps.map((step) => (step.id === "agent" ? { ...step, status: "complete" as const } : step));
    const agent = (available: readonly string[] | null) => personalizeGettingStartedSteps(signedIn, { goals: [], tools: ["codex"] }, available)
      .find((step) => step.id === "agent");
    expect(agent(["claude"])).toEqual({ id: "agent", label: "Log in to Codex", status: "incomplete" });
    expect(agent(["codex"])).toEqual({ id: "agent", label: "Log in to Codex", status: "complete" });
    expect(agent(null)?.status).toBe("complete");
  });

  it("records which agents are signed in", () => {
    const fulfilled = (value: unknown): PromiseSettledResult<unknown> => ({ status: "fulfilled", value });
    const snapshot = deriveGettingStartedSnapshot({
      github: fulfilled({ authenticated: false }),
      integrations: fulfilled([]),
      agents: fulfilled({ agents: [{ agent: "claude", status: "available" }, { agent: "codex", status: "missing" }] }),
      projects: fulfilled({ projects: [] }),
      chats: fulfilled({ items: [] }),
      billing: fulfilled({ access: { runtimeProxyAllowed: false } }),
    });
    expect(snapshot.availableAgents).toEqual(["claude"]);
  });

  it("keeps the labels that completion can't check", () => {
    // Only Codex and Claude count as a logged-in agent, so OpenCode never names the step.
    expect(personalizeGettingStartedSteps(steps, { goals: [], tools: ["opencode", "github", "gmail"] })).toEqual(steps);
  });
});
