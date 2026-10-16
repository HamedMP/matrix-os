import { createContext, useContext } from "react";

/**
 * What a message that was not sent offers, by the message's id. The screen
 * that owns the composer provides it around its message list, so the list
 * itself stays drawn from what it is given.
 */
export interface UnsentMessageActions {
  /** Sends the message again, as the same send. */
  onRetry: (messageId: string) => void;
  /** Takes the message out of the chat and back into the composer. */
  onEdit: (messageId: string) => void;
}

const UnsentMessageActionsContext = createContext<UnsentMessageActions | null>(null);

export const UnsentMessageActionsProvider = UnsentMessageActionsContext.Provider;

/** The actions of the chat a message is shown in; null where nothing can be done about one that was not sent. */
export function useUnsentMessageActions(): UnsentMessageActions | null {
  return useContext(UnsentMessageActionsContext);
}
