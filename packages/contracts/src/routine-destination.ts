import { z } from "zod/v4";
import { RoutineCliTargetPreferenceSchema } from "#bots/routine-cli";
export { RoutineCliRememberTargetSchema, RoutineCliResetTargetSchema } from "#bots/routine-cli";
export const ROUTINE_DESTINATION_PATH = "/api/routine-cli/destination";
export const RoutineDestinationViewSchema = z.object({ preference: RoutineCliTargetPreferenceSchema,
  availability: z.enum(["unset", "available", "unavailable"]) }).strict().refine(value => (value.preference.target === null) === (value.availability === "unset"));
export type RoutineDestinationView = z.infer<typeof RoutineDestinationViewSchema>;
export const ROUTINE_DESTINATION_COPY = {
  title: "Routine destination", unknown: "Current routine destination is unavailable.", loading: "Checking the routine destination…", empty: "No routine destination selected.",
  selected: "This Chat is the routine destination on this Computer.", other: "Another Bot Chat is the routine destination on this Computer.",
  unavailable: "The saved routine destination is unavailable. Select an eligible Chat again or clear it.",
  explanation: "Shared across Claude, Codex, Hermes, OpenCode and Pi on this Computer. This choice does not authorize routine operations, background runs or app access.",
  remember: "Use this Chat", reselect: "Use this Chat again", reset: "Clear destination", retry: "Refresh destination",
  error: "The routine destination could not be loaded. Refresh and try again.",
  saveError: "The destination change could not be confirmed. Refresh before trying again.",
  conflict: "The destination changed elsewhere. Review the current selection before trying again.", pending: "Saving destination…",
} as const;
export function routineDestinationPresentation(view: RoutineDestinationView, current: { botId: string; chatId: string }) {
  const same = view.preference.target?.botId === current.botId && view.preference.target.chatId === current.chatId;
  return { message: view.availability === "unset" ? ROUTINE_DESTINATION_COPY.empty : view.availability === "unavailable"
    ? ROUTINE_DESTINATION_COPY.unavailable : same ? ROUTINE_DESTINATION_COPY.selected : ROUTINE_DESTINATION_COPY.other,
  remember: same && view.availability === "unavailable" ? ROUTINE_DESTINATION_COPY.reselect : ROUTINE_DESTINATION_COPY.remember,
  canRemember: !(same && view.availability === "available"), canReset: view.preference.target !== null };
}
