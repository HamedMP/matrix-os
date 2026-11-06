import { describe, expect, it } from "vitest";
import {
  GETTING_STARTED_STEP_IDS,
  ONBOARDING_TASK_IDS,
  getStartedStepOrder,
  getStartedTaskOrder,
  orderByIds,
  personalizeGettingStartedSteps,
  deriveGettingStartedSnapshot,
  emptyGettingStartedSnapshot,
  gettingStartedRows,
  mergeTrySuggestion,
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

describe("Getting started rows from the owner's choices", () => {
  const fulfilled = (value: unknown): PromiseSettledResult<unknown> => ({ status: "fulfilled", value });
  function snapshot(services: string[]) {
    return deriveGettingStartedSnapshot({
      github: fulfilled({ authenticated: false }),
      integrations: fulfilled(services.map((service, index) => ({ id: `c${index}`, service, status: "active" }))),
      agents: fulfilled({ agents: [] }),
      projects: fulfilled({ projects: [] }),
      chats: fulfilled({ items: [] }),
      billing: fulfilled({ access: { runtimeProxyAllowed: true } }),
    });
  }

  it("keeps the five steps without answers", () => {
    const { rows, completedCount, total } = gettingStartedRows(snapshot(["linear"]), null);
    expect(rows.map((row) => row.id)).toEqual([...GETTING_STARTED_STEP_IDS]);
    expect(rows.every((row) => row.kind === "step")).toBe(true);
    expect({ completedCount, total }).toEqual({ completedCount: 1, total: 5 });
  });

  it("adds a connect row for each picked tool the five steps don't already cover", () => {
    const answers = { goals: ["code" as const], tools: ["github" as const, "linear" as const, "figma" as const, "codex" as const, "gmail" as const] };
    const { rows, completedCount, total } = gettingStartedRows(snapshot(["linear"]), answers);
    const tools = rows.filter((row) => row.kind === "tool");
    expect(tools).toEqual([
      {
        kind: "tool", id: "tool:linear", label: "Connect Linear", status: "complete", service: "linear",
        try: { label: "Summarize my open Linear issues", prompt: "Summarize my open Linear issues by priority. Don't change anything." },
      },
      { kind: "tool", id: "tool:figma", label: "Connect Figma", status: "incomplete", service: "figma", connect: "figma" },
    ]);
    expect(rows[0]).toMatchObject({ kind: "step", id: "agent", label: "Log in to Codex" });
    expect({ completedCount, total }).toEqual({ completedCount: 2, total: 7 });
  });

  it("marks tool rows unavailable while connections are unknown", () => {
    const { rows } = gettingStartedRows(emptyGettingStartedSnapshot(), { goals: [], tools: ["slack"] });
    expect(rows.find((row) => row.id === "tool:slack")?.status).toBe("unavailable");
  });

  it("adds a chat row per added bot and drops bots the owner removed", () => {
    const answers = { goals: ["business" as const], tools: [], bots: ["personal-daily-brief" as const, "jev-inbox-triage" as const, "event-request-desk" as const] };
    const { rows, total } = gettingStartedRows(snapshot([]), answers, {
      "personal-daily-brief": "complete",
      "jev-inbox-triage": null,
    });
    expect(rows.filter((row) => row.kind === "bot")).toEqual([
      { kind: "bot", id: "bot:personal-daily-brief", label: "Chat with Daily Brief", status: "complete", recipeId: "personal-daily-brief" },
      { kind: "bot", id: "bot:event-request-desk", label: "Chat with Event Request Desk", status: "incomplete", recipeId: "event-request-desk" },
    ]);
    expect(total).toBe(7);
  });

  it("keeps a bot whose creation failed as a Create row instead of dropping it", () => {
    const answers = { goals: [], tools: [], bots: ["writing-bot" as const, "echo" as const] };
    const { rows } = gettingStartedRows(snapshot([]), answers, { "writing-bot": "missing", echo: null });
    expect(rows.filter((row) => row.kind === "bot")).toEqual([
      { kind: "bot", id: "bot:writing-bot", label: "Create Writing Bot", status: "incomplete", recipeId: "writing-bot", create: true },
    ]);
  });
});

describe("Getting started rows close the loop", () => {
  const fulfilled = (value: unknown): PromiseSettledResult<unknown> => ({ status: "fulfilled", value });
  function snapshot(services: string[], agents: { agent: string; status: string }[] = []) {
    return deriveGettingStartedSnapshot({
      github: fulfilled({ authenticated: false }),
      integrations: fulfilled(services.map((service, index) => ({ id: `c${index}`, service, status: "active" }))),
      agents: fulfilled({ agents }),
      projects: fulfilled({ projects: [] }),
      chats: fulfilled({ items: [] }),
      billing: fulfilled({ access: { runtimeProxyAllowed: false } }),
    });
  }
  const row = (rows: ReturnType<typeof gettingStartedRows>["rows"], id: string) => rows.find((candidate) => candidate.id === id);

  it("names the app each unfinished connect row signs in to, and nothing once done", () => {
    const { rows } = gettingStartedRows(snapshot([]), { goals: [], tools: ["linear"] });
    expect(row(rows, "github")).toMatchObject({ connect: "github" });
    expect(row(rows, "email-calendar")).toMatchObject({ label: "Connect email & calendar", connect: "gmail" });
    expect(row(rows, "tool:linear")).toMatchObject({ connect: "linear" });
    const done = gettingStartedRows(snapshot(["github", "linear", "gmail", "google_calendar"]), { goals: [], tools: ["linear"] }).rows;
    for (const id of ["github", "email-calendar", "tool:linear"]) expect(row(done, id)).not.toHaveProperty("connect");
  });

  it("shows email & calendar as half done and connects the missing one", () => {
    expect(row(gettingStartedRows(snapshot(["gmail"]), null).rows, "email-calendar"))
      .toMatchObject({ label: "Connect Google Calendar (1 of 2)", status: "incomplete", connect: "google_calendar" });
    expect(row(gettingStartedRows(snapshot(["google_calendar"]), null).rows, "email-calendar"))
      .toMatchObject({ label: "Connect Gmail (1 of 2)", connect: "gmail" });
  });

  it("says where the coding agent must be signed in until it is", () => {
    expect(row(gettingStartedRows(snapshot([]), null).rows, "agent")).toMatchObject({ detail: "On your Matrix computer, where your AI runs" });
    expect(row(gettingStartedRows(snapshot([], [{ agent: "codex", status: "available" }]), null).rows, "agent")).not.toHaveProperty("detail");
  });
});

describe("Getting started try actions", () => {
  const fulfilled = (value: unknown): PromiseSettledResult<unknown> => ({ status: "fulfilled", value });
  function snapshot(services: string[], github = false) {
    return deriveGettingStartedSnapshot({
      github: fulfilled({ authenticated: github }),
      integrations: fulfilled(services.map((service, index) => ({ id: `c${index}`, service, status: "active" }))),
      agents: fulfilled({ agents: [] }),
      projects: fulfilled({ projects: [] }),
      chats: fulfilled({ items: [] }),
      billing: fulfilled({ access: { runtimeProxyAllowed: true } }),
    });
  }
  const row = (rows: ReturnType<typeof gettingStartedRows>["rows"], id: string) => rows.find((candidate) => candidate.id === id);

  it("turns a finished connection into something useful to try, read-only", () => {
    const { rows } = gettingStartedRows(snapshot(["gmail", "google_calendar", "linear", "figma"], true), { goals: [], tools: ["linear", "figma"] });
    expect(row(rows, "email-calendar")?.try?.label).toBe("Find emails that need a reply");
    expect(row(rows, "github")?.try?.label).toBe("List my GitHub repos");
    expect(row(rows, "tool:linear")?.try?.label).toBe("Summarize my open Linear issues");
    for (const id of ["email-calendar", "github", "tool:linear"]) {
      expect(row(rows, id)?.try?.prompt).toMatch(/Don't (send|change) anything/);
    }
    expect(row(rows, "tool:figma")).not.toHaveProperty("try");
  });

  it("offers nothing to try until the step is done", () => {
    const { rows } = gettingStartedRows(snapshot(["gmail"]), { goals: [], tools: ["linear"] });
    for (const id of ["email-calendar", "github", "tool:linear"]) expect(row(rows, id)).not.toHaveProperty("try");
  });
});

describe("widget tasks from the owner's choices", () => {
  it("leads with the tasks their picked tools and starter unlock, then their goals", () => {
    expect(getStartedTaskOrder(["business"], { tools: ["github"] })[0]).toBe("work-on-code");
    expect(getStartedTaskOrder([], { tools: ["google-calendar"] })[0]).toBe("plan-week");
    expect(getStartedTaskOrder(["explore"], { starter: "ask-anything" })[0]).toBe("research");
    expect(getStartedTaskOrder(["explore"], { starter: "build-something-small" })[0]).toBe("build-website");
    expect(getStartedTaskOrder(["code"], { tools: ["google-calendar"] }).slice(0, 2)).toEqual(["plan-week", "work-on-code"]);
  });

  it("merges a Try suggestion without ever losing the owner's own text", () => {
    let draft = mergeTrySuggestion("", null, "A");
    expect(draft.text).toBe("A");
    draft = mergeTrySuggestion(draft.text, draft, "B");
    expect(draft.text).toBe("B");
    draft = mergeTrySuggestion("my idea", draft, "C");
    expect(draft.text).toBe("my idea\n\nC");
    draft = mergeTrySuggestion(draft.text, draft, "D");
    expect(draft.text).toBe("my idea\n\nD");
    // An edit after the suggestion is the owner's text now.
    draft = mergeTrySuggestion("my idea\n\nD, and more", draft, "E");
    expect(draft.text).toBe("my idea\n\nD, and more\n\nE");
  });
});
