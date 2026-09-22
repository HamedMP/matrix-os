import { describe, expect, it } from "vitest";
import {
  JEV_EMAIL_TRIAGE_ANSWER_IDS,
  JEV_EMAIL_TRIAGE_RECIPE_ID,
  JEV_MODEL_ID,
} from "@matrix-os/contracts";
import { EMAIL_TRIAGE_RECIPE } from "../../packages/gateway/src/jev/email-triage-recipe.js";

describe("email-triage-v1 recipe", () => {
  it("owns one immutable Boolean question for every stable answer id", () => {
    expect(EMAIL_TRIAGE_RECIPE.id).toBe(JEV_EMAIL_TRIAGE_RECIPE_ID);
    expect(EMAIL_TRIAGE_RECIPE.model).toBe(JEV_MODEL_ID);
    expect(EMAIL_TRIAGE_RECIPE.questions.map((question) => question.id)).toEqual(JEV_EMAIL_TRIAGE_ANSWER_IDS);
    expect(EMAIL_TRIAGE_RECIPE.questions.every((question) => question.type === "boolean")).toBe(true);
    expect(new Set(EMAIL_TRIAGE_RECIPE.questions.map((question) => question.question)).size).toBe(7);
    expect(Object.isFrozen(EMAIL_TRIAGE_RECIPE)).toBe(true);
    expect(Object.isFrozen(EMAIL_TRIAGE_RECIPE.questions)).toBe(true);
    expect(EMAIL_TRIAGE_RECIPE.questions.every(Object.isFrozen)).toBe(true);
  });
});
