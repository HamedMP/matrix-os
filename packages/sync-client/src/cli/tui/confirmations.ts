import type { TuiAction, TuiActionDanger } from "./actions.js";

export interface ConfirmationSubject {
  id: string;
  title: string;
  danger: TuiActionDanger;
  confirmationPhrase?: string;
}

interface BaseConfirmationRequest {
  actionId: string;
  title: string;
  prompt: string;
}

export type ConfirmationRequest =
  | (BaseConfirmationRequest & { danger: "confirm" })
  | (BaseConfirmationRequest & { danger: "exact-phrase"; confirmationPhrase: string });

export function buildConfirmationRequest(
  action: ConfirmationSubject | TuiAction,
): ConfirmationRequest | null {
  if (action.danger === "none") {
    return null;
  }
  if (action.danger === "exact-phrase") {
    const phrase = action.confirmationPhrase?.trim();
    if (phrase) {
      return {
        actionId: action.id,
        title: action.title,
        danger: "exact-phrase",
        prompt: `Type ${phrase} to continue.`,
        confirmationPhrase: phrase,
      };
    }
  }
  return {
    actionId: action.id,
    title: action.title,
    danger: "confirm",
    prompt: "Type confirm to continue.",
  };
}

export function canConfirmAction(
  request: ConfirmationRequest | null,
  typedValue: string,
): boolean {
  if (request === null) {
    return true;
  }
  const normalized = typedValue.trim();
  if (request.danger === "confirm") {
    return normalized === "confirm";
  }
  return normalized === request.confirmationPhrase;
}
