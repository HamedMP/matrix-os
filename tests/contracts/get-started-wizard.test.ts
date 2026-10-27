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
    expect(GET_STARTED_WIZARD_STEPS).toEqual(["name", "goals", "agents", "tools", "ai", "gallery", "bots", "summary"]);
  });

  it("walks forward and back through every step without passing the ends", () => {
    let state = initialGetStartedWizard();
    state = run(state, { type: "back" });
    expect(state.step).toBe("name");
    state = run(state, ...Array.from({ length: GET_STARTED_WIZARD_STEPS.length }, () => ({ type: "next" }) as const));
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

  it("toggles goals in the order they were picked", () => {
    const state = run(
      initialGetStartedWizard(),
      { type: "toggle-goal", goal: "build" },
      { type: "toggle-goal", goal: "code" },
      { type: "toggle-goal", goal: "assistant" },
      { type: "toggle-goal", goal: "build" },
    );
    expect(state.goals).toEqual(["code", "assistant"]);
  });

  it("only keeps answers that belong to the goals still chosen", () => {
    const state = run(
      initialGetStartedWizard(),
      { type: "toggle-goal", goal: "explore" },
      { type: "toggle-goal", goal: "code" },
      { type: "pick-app-idea", id: "habit-tracker" },
      { type: "pick-starter", id: "ask-anything" },
    );
    expect(getStartedAnswersFromWizard(state)).toEqual({ goals: ["explore", "code"], tools: [], appIdea: "habit-tracker", starter: "ask-anything" });
    // The app idea is also App Gallery's own answer, so it stays; the starter goes with exploring.
    expect(getStartedAnswersFromWizard(run(state, { type: "toggle-goal", goal: "explore" }))).toEqual({ goals: ["code"], tools: [], appIdea: "habit-tracker" });
  });

  it("keeps saved tools until the surface has actually read its connections", () => {
    // Resumed at the summary: tools saved earlier, connections and agents not read yet.
    const resumed = initialGetStartedWizard({ step: GET_STARTED_WIZARD_STEPS.indexOf("summary"), goals: ["code"], tools: ["codex", "github", "linear"] });
    expect(getStartedAnswersFromWizard(resumed).tools).toEqual(["codex", "github", "linear"]);
    // Once read, the real connections replace the saved ones.
    expect(getStartedAnswersFromWizard(run(resumed, { type: "connected", services: ["github"] })).tools).toEqual(["codex", "github"]);
    expect(getStartedAnswersFromWizard(run(resumed, { type: "connected", services: [] })).tools).toEqual(["codex"]);
    expect(getStartedAnswersFromWizard(run(resumed, { type: "agents-connected", agents: [] })).tools).toEqual(["github", "linear"]);
  });

  it("records a coding agent as a tool when it is connected, not when it is picked", () => {
    // Spec 636: the coding agents screen has no picks; a saved chip pick from before is not an answer
    // once the screen has read this computer's agents.
    let state = run(initialGetStartedWizard({ goals: ["code"], tools: ["codex"] }), { type: "agents-connected", agents: [] });
    expect(getStartedAnswersFromWizard(state).tools).toEqual([]);
    state = run(state, { type: "agents-connected", agents: ["codex", "claude"] });
    // Coding agents lead in catalog order, whatever order they were reported in.
    expect(getStartedAnswersFromWizard(state).tools).toEqual(["claude-code", "codex"]);
    expect(state.agents).toEqual(["codex", "claude"]);
  });

  it("records connected integrations as tools, after the connected coding agents", () => {
    let state = run(initialGetStartedWizard(), { type: "toggle-goal", goal: "code" }, { type: "agents-connected", agents: ["codex"] });
    state = run(state, { type: "connected", services: ["linear", "github", "twitter"] });
    expect(getStartedAnswersFromWizard(state).tools).toEqual(["codex", "github", "linear"]);
    // Skipping a step clears picks, never real connections or sign-ins.
    expect(getStartedAnswersFromWizard(run({ ...state, step: "tools" }, { type: "skip" })).tools).toEqual(["codex", "github", "linear"]);
    expect(run({ ...state, step: "agents" }, { type: "skip" })).toMatchObject({ step: "tools", agents: ["codex"] });
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

  it("keeps the App Gallery app idea when step 3 is skipped", () => {
    const back = { ...initialGetStartedWizard(), step: "tools" as const, appIdea: "habit-tracker" as const };
    expect(run(back, { type: "skip" })).toMatchObject({ step: "ai", appIdea: "habit-tracker" });
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
    expect(state).toMatchObject({ step: "agents", goals: [] });
    state = run(state, { type: "skip" });
    expect(state.step).toBe("tools");
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
      { type: "agents-connected", agents: ["claude"] },
    );
    expect(state.step).toBe("agents");
    expect(GetStartedAnswersSchema.parse(getStartedAnswersFromWizard(state))).toEqual({
      name: "Sam", goals: ["code"], tools: ["claude-code"],
    });
    expect(GetStartedDraftSchema.parse(getStartedDraftFromWizard(state))).toEqual({
      step: 2, name: "Sam", goals: ["code"], tools: ["claude-code"],
    });
  });

  it("resumes from a saved draft", () => {
    const state = initialGetStartedWizard({ step: 3, name: "Sam", goals: ["build"], tools: [], appIdea: "recipe-box" });
    expect(state).toMatchObject({ step: "tools", name: "Sam", goals: ["build"], appIdea: "recipe-box", agents: null });
  });

  it("resumes a draft saved before the coding agents step at most one step earlier", () => {
    // Saved as "tools" (index 2) before spec 636: the owner sees the new step, then tools, answers kept.
    expect(initialGetStartedWizard({ step: 2, goals: ["code"], tools: ["github"] })).toMatchObject({ step: "agents", tools: ["github"] });
  });

  it("resumes an unknown or missing step at the start", () => {
    expect(initialGetStartedWizard({ goals: ["code"], tools: [] }).step).toBe("name");
  });

  it("reports progress across the questions only", () => {
    expect(getStartedQuestionProgress(initialGetStartedWizard())).toEqual({ current: 0, total: 7 });
    expect(getStartedQuestionProgress(initialGetStartedWizard({ step: 7, goals: [], tools: [] }))).toEqual({ current: 7, total: 7 });
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
