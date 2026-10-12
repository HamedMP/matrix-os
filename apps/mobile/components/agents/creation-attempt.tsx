import { createContext, use, useRef, type ReactNode, type RefObject } from "react";

/** A request to create an agent that has been sent and not yet confirmed. */
export interface CreationAttempt {
  /** The account and computer it was sent for. */
  scope: string;
  /** The template and name it asked for. */
  key: string;
  requestId: string;
}

const CreationAttemptContext = createContext<RefObject<CreationAttempt | null> | null>(null);

/**
 * Keeps the unconfirmed creation attempt for as long as the Agents tab lives,
 * so leaving the new-agent screen and coming back retries the same request
 * instead of sending a second one.
 */
export function CreationAttemptProvider({ children }: { children: ReactNode }) {
  const attempt = useRef<CreationAttempt | null>(null);
  return <CreationAttemptContext value={attempt}>{children}</CreationAttemptContext>;
}

/** The attempt the Agents tab keeps, or one of this screen's own when it is drawn outside the tab. */
export function useCreationAttempt(): RefObject<CreationAttempt | null> {
  const shared = use(CreationAttemptContext);
  const own = useRef<CreationAttempt | null>(null);
  return shared ?? own;
}
