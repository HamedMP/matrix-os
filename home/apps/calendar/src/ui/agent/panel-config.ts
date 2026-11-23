/** Answers kept in the panel; older ones scroll away. */
export const MAX_AGENT_ENTRIES = 20;

/** Starter questions shown before the first answer. */
export const AGENT_SUGGESTIONS = [
  "What is on tomorrow?",
  "When are we all free this week?",
  "Find a two-hour window before Friday",
  "Move my Thursday one-on-one to a slot we are both free",
  "Set up a weekly closing call with the deal team until the 30th",
] as const;
