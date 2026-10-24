import { describe, expect, it } from "vitest";
import {
  GET_STARTED_RECIPE_BOTS,
  GET_STARTED_RECIPE_BOTS_MAX,
  GetStartedAnswersSchema,
  getStartedAnswersFromWizard,
  getStartedRecipeBotIdsForGoals,
  getStartedRecipeBotSuggestions,
  initialGetStartedWizard,
  reduceGetStartedWizard,
} from "../../packages/contracts/src/index.js";

describe("Bots for you", () => {
  it("suggests bots by goal, in goal order, capped", () => {
    expect(getStartedRecipeBotIdsForGoals(["business"])).toEqual(["personal-daily-brief", "jev-inbox-triage", "event-request-desk"]);
    expect(getStartedRecipeBotIdsForGoals(["code", "assistant"])).toEqual(["writing-bot", "personal-daily-brief", "echo"]);
    expect(getStartedRecipeBotIdsForGoals(["business", "assistant", "explore"])).toHaveLength(GET_STARTED_RECIPE_BOTS_MAX);
    expect(getStartedRecipeBotIdsForGoals([])).toEqual(["writing-bot", "personal-daily-brief"]);
  });

  it("names the apps a bot still needs", () => {
    const [brief, triage] = getStartedRecipeBotSuggestions(["business"], new Set(["gmail"]));
    expect(brief).toMatchObject({ bot: { recipeId: "personal-daily-brief" }, missing: ["google_calendar"] });
    expect(triage).toMatchObject({ bot: { recipeId: "jev-inbox-triage" }, missing: [] });
  });

  it("only accepts known recipes, up to the cap, without duplicates", () => {
    expect(GetStartedAnswersSchema.parse({ bots: ["writing-bot", "writing-bot"] }).bots).toEqual(["writing-bot"]);
    expect(GetStartedAnswersSchema.parse({ bots: [] }).bots).toBeUndefined();
    expect(GetStartedAnswersSchema.safeParse({ bots: ["matrix-bot"] }).success).toBe(false);
    expect(GetStartedAnswersSchema.safeParse({ bots: ["anything"] }).success).toBe(false);
    expect(GetStartedAnswersSchema.safeParse({ bots: GET_STARTED_RECIPE_BOTS.map((bot) => bot.recipeId) }).success).toBe(false);
  });

  it("keeps added bots only while they are still suggested for the goals", () => {
    let state = initialGetStartedWizard({ step: 5, goals: ["business"], tools: [] });
    state = reduceGetStartedWizard(state, { type: "toggle-bot", id: "jev-inbox-triage" });
    expect(getStartedAnswersFromWizard(state).bots).toEqual(["jev-inbox-triage"]);
    state = reduceGetStartedWizard(state, { type: "toggle-goal", goal: "business" });
    expect(getStartedAnswersFromWizard(state).bots).toBeUndefined();
    state = reduceGetStartedWizard(state, { type: "toggle-goal", goal: "business" });
    state = reduceGetStartedWizard(state, { type: "toggle-bot", id: "jev-inbox-triage" });
    expect(getStartedAnswersFromWizard(state).bots).toBeUndefined();
  });

  it("resumes added bots from a draft", () => {
    expect(initialGetStartedWizard({ goals: ["assistant"], tools: [], bots: ["echo"] }).bots).toEqual(["echo"]);
  });
});
