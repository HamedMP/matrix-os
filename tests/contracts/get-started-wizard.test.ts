import { describe, expect, it } from "vitest";
import {
  GET_STARTED_NAME_MAX_CHARS,
  GET_STARTED_WIZARD_STEPS,
  GetStartedAnswersSchema,
  GetStartedDraftSchema,
  getStartedAnswersFromWizard,
  getStartedDraftFromWizard,
  getStartedQuestionProgress,
  getStartedSuggestedName,
  initialGetStartedWizard,
  reduceGetStartedWizard,
  type GetStartedWizardEvent,
  type GetStartedWizardState,
} from "../../packages/contracts/src/index.js";

function run(state: GetStartedWizardState, ...events: GetStartedWizardEvent[]) {
  return events.reduce(reduceGetStartedWizard, state);
}

describe("get started wizard", () => {
  it("starts on the name question with nothing chosen", () => {
    const state = initialGetStartedWizard();
    expect(state.step).toBe("name");
    expect(getStartedAnswersFromWizard(state)).toEqual({ goals: [], tools: [] });
    expect(GET_STARTED_WIZARD_STEPS).toEqual(["name", "goals", "tools", "ai", "gallery", "bots", "summary"]);
  });

  it("walks forward and back through every step without passing the ends", () => {
    let state = initialGetStartedWizard();
    state = run(state, { type: "back" });
    expect(state.step).toBe("name");
    state = run(state, { type: "next" }, { type: "next" }, { type: "next" }, { type: "next" }, { type: "next" }, { type: "next" }, { type: "next" });
    expect(state.step).toBe("summary");
    state = run(state, { type: "back" });
    expect(state.step).toBe("bots");
  });

  it("caps the name while typing and trims it in the answers", () => {
    const state = run(initialGetStartedWizard(), { type: "name", value: `  ${"a".repeat(60)}` });
    expect(state.name).toHaveLength(GET_STARTED_NAME_MAX_CHARS);
    expect(getStartedAnswersFromWizard(run(initialGetStartedWizard(), { type: "name", value: "  Sam  " })).name).toBe("Sam");
  });

  it("strips SOUL markers from the name before it reaches the server", () => {
    expect(getStartedAnswersFromWizard(run(initialGetStartedWizard(), { type: "name", value: "Sam<!-- -->" })).name).toBe("Sam");
  });

  it("drops a blank name and strips control characters from the answers", () => {
    expect(getStartedAnswersFromWizard(run(initialGetStartedWizard(), { type: "name", value: "   " })).name).toBeUndefined();
    expect(getStartedAnswersFromWizard(run(initialGetStartedWizard(), { type: "name", value: "Sa\u0007m" })).name).toBe("Sam");
  });

  it("toggles goals and tools in the order they were picked", () => {
    const state = run(
      initialGetStartedWizard(),
      { type: "toggle-goal", goal: "build" },
      { type: "toggle-goal", goal: "code" },
      { type: "toggle-tool", tool: "github" },
      { type: "toggle-tool", tool: "linear" },
      { type: "toggle-tool", tool: "github" },
    );
    expect(state.goals).toEqual(["build", "code"]);
    expect(state.tools).toEqual(["linear"]);
  });

  it("only keeps answers that belong to the goals still chosen", () => {
    const state = run(
      initialGetStartedWizard(),
      { type: "toggle-goal", goal: "code" },
      { type: "toggle-goal", goal: "build" },
      { type: "toggle-tool", tool: "codex" },
      { type: "pick-app-idea", id: "habit-tracker" },
      { type: "pick-starter", id: "ask-anything" },
      { type: "toggle-goal", goal: "build" },
    );
    // The app idea is also App Gallery's own answer, so it stays.
    expect(getStartedAnswersFromWizard(state)).toEqual({ goals: ["code"], tools: ["codex"], appIdea: "habit-tracker" });
    expect(getStartedAnswersFromWizard(run(state, { type: "toggle-goal", goal: "code" })).tools).toEqual([]);
  });

  it("keeps saved tools until the surface has actually read its connections", () => {
    // Resumed at the summary: tools saved earlier, connections not read yet.
    const resumed = initialGetStartedWizard({ step: 6, goals: ["code"], tools: ["codex", "github", "linear"] });
    expect(getStartedAnswersFromWizard(resumed).tools).toEqual(["codex", "github", "linear"]);
    // Once read, the real connections replace the saved ones.
    expect(getStartedAnswersFromWizard(run(resumed, { type: "connected", services: ["github"] })).tools).toEqual(["codex", "github"]);
    expect(getStartedAnswersFromWizard(run(resumed, { type: "connected", services: [] })).tools).toEqual(["codex"]);
  });

  it("records connected integrations as tools, after the coding agents picked", () => {
    let state = run(initialGetStartedWizard(), { type: "toggle-goal", goal: "code" }, { type: "toggle-tool", tool: "codex" });
    state = run(state, { type: "connected", services: ["linear", "github", "twitter"] });
    expect(getStartedAnswersFromWizard(state).tools).toEqual(["codex", "github", "linear"]);
    // Skipping the step clears picks, never real connections.
    expect(getStartedAnswersFromWizard(run({ ...state, step: "tools" }, { type: "skip" })).tools).toEqual(["github", "linear"]);
  });

  it("keeps a starter only when exploring is on screen", () => {
    const state = run(initialGetStartedWizard(), { type: "pick-starter", id: "play-a-game" });
    expect(getStartedAnswersFromWizard(state).starter).toBe("play-a-game");
    expect(getStartedAnswersFromWizard(run(state, { type: "toggle-goal", goal: "code" })).starter).toBeUndefined();
  });

  it("keeps an app idea picked in App Gallery whatever the goals", () => {
    const state = run(initialGetStartedWizard(), { type: "toggle-goal", goal: "code" }, { type: "pick-app-idea", id: "habit-tracker" });
    expect(getStartedAnswersFromWizard(state).appIdea).toBe("habit-tracker");
  });

  it("toggles the single app idea", () => {
    let state = run(initialGetStartedWizard(), { type: "toggle-goal", goal: "build" }, { type: "pick-app-idea", id: "client-crm" });
    expect(state.appIdea).toBe("client-crm");
    state = run(state, { type: "pick-app-idea", id: "client-crm" });
    expect(state.appIdea).toBeUndefined();
  });

  it("skip clears the current question's answer and moves on", () => {
    let state = run(initialGetStartedWizard(), { type: "name", value: "Sam" }, { type: "skip" });
    expect(state).toMatchObject({ step: "goals", name: "" });
    state = run(state, { type: "toggle-goal", goal: "code" }, { type: "skip" });
    expect(state).toMatchObject({ step: "tools", goals: [] });
    state = run(state, { type: "pick-starter", id: "ask-anything" }, { type: "skip" });
    expect(state.step).toBe("ai");
    state = run(state, { type: "bot", patch: { name: "Atlas" } }, { type: "skip" });
    expect(state).toMatchObject({ step: "gallery", botChosen: false, bot: { name: "Matrix" } });
    state = run(state, { type: "pick-app-idea", id: "recipe-box" }, { type: "skip" });
    expect(state).toMatchObject({ step: "bots", appIdea: undefined });
    state = run(state, { type: "toggle-bot", id: "writing-bot" }, { type: "skip" });
    expect(state).toMatchObject({ step: "summary", bots: [] });
    expect(getStartedAnswersFromWizard(state)).toEqual({ goals: [], tools: [] });
  });

  it("produces answers and drafts that pass the server schemas", () => {
    const state = run(
      initialGetStartedWizard(),
      { type: "name", value: "Sam" },
      { type: "next" },
      { type: "toggle-goal", goal: "code" },
      { type: "next" },
      { type: "toggle-tool", tool: "claude-code" },
    );
    expect(GetStartedAnswersSchema.parse(getStartedAnswersFromWizard(state))).toEqual({
      name: "Sam", goals: ["code"], tools: ["claude-code"],
    });
    expect(GetStartedDraftSchema.parse(getStartedDraftFromWizard(state))).toEqual({
      step: 2, name: "Sam", goals: ["code"], tools: ["claude-code"],
    });
  });

  it("resumes from a saved draft", () => {
    const state = initialGetStartedWizard({ step: 2, name: "Sam", goals: ["build"], tools: [], appIdea: "recipe-box" });
    expect(state).toMatchObject({ step: "tools", name: "Sam", goals: ["build"], appIdea: "recipe-box" });
  });

  it("resumes an unknown or missing step at the start", () => {
    expect(initialGetStartedWizard({ goals: ["code"], tools: [] }).step).toBe("name");
  });

  it("reports progress across the questions only", () => {
    expect(getStartedQuestionProgress(initialGetStartedWizard())).toEqual({ current: 0, total: 6 });
    expect(getStartedQuestionProgress(initialGetStartedWizard({ step: 6, goals: [], tools: [] }))).toEqual({ current: 6, total: 6 });
  });

  it("suggests the first name from the sign-in account, only when it is a plain name", () => {
    expect(getStartedSuggestedName("Sam Lee")).toBe("Sam");
    expect(getStartedSuggestedName("  Jean-Luc  Picard ")).toBe("Jean-Luc");
    expect(getStartedSuggestedName("Zoë")).toBe("Zoë");
    // Usernames and emails are not names; the owner types their own.
    for (const value of [null, undefined, "", "   ", "sam_lee", "sam42", "sam@example.com", "sam.lee", "<!--x", "a\u0007b", "x".repeat(GET_STARTED_NAME_MAX_CHARS + 1)]) {
      expect(getStartedSuggestedName(value)).toBeNull();
    }
  });
});
