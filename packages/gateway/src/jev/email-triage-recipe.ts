import {
  JEV_EMAIL_TRIAGE_RECIPE_ID,
  JEV_EMAIL_TRIAGE_INSTRUCTIONS,
  JEV_MODEL_ID,
  type JevEmailTriageAnswerId,
} from "@matrix-os/contracts";

export interface JevBooleanQuestion {
  readonly id: JevEmailTriageAnswerId;
  readonly type: "boolean";
  readonly question: string;
}

function booleanQuestion(id: JevEmailTriageAnswerId, question: string): Readonly<JevBooleanQuestion> {
  return Object.freeze({ id, type: "boolean" as const, question });
}

export const EMAIL_TRIAGE_RECIPE = Object.freeze({
  id: JEV_EMAIL_TRIAGE_RECIPE_ID,
  model: JEV_MODEL_ID,
  questions: Object.freeze([
    ...Object.entries(JEV_EMAIL_TRIAGE_INSTRUCTIONS).map(([id, instructions]) =>
      booleanQuestion(id as JevEmailTriageAnswerId, instructions)),
  ]),
});
