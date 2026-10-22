import React, { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { chatAgentMutedStyle, chatAgentSurfaceStyle } from "../chat-agents/theme.js";
type Review = { node: HTMLElement; expiresAt: number };
const Context = createContext<{ review: Review | null; register(value: Review): () => void;
  grantsRevision: number; grantsChanged(): void } | null>(null);
/** One pending broker action per Chat. Registration is local to this window. */
export function BrowserPermissionReviewProvider({ children }: { children: ReactNode }) {
  const [review, setReview] = useState<Review | null>(null);
  const [grantsRevision, setGrantsRevision] = useState(0);
  const grantsChanged = useCallback(() => setGrantsRevision(value => (value + 1) % 1_000_000), []);
  const register = useCallback((value: Review) => {
    setReview(value); return () => setReview(current => current === value ? null : current);
  }, []);
  return <Context.Provider value={{ review, register, grantsRevision, grantsChanged }}>{children}</Context.Provider>;
}
export function useBrowserPermissionReview() { return useContext(Context)?.register; }
export function useBrowserPermissionGrants() { return useContext(Context); }
export function BrowserPermissionReminder() {
  const context = useContext(Context);
  if (!context?.review || context.review.expiresAt <= Date.now()) return null;
  const { node } = context.review;
  return <div role="status" className="mb-2 flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-xs" style={{ ...chatAgentSurfaceStyle, ...chatAgentMutedStyle }}>
    <span>Waiting for you · Matrix Browser</span><button type="button" className="underline" onClick={() => {
      node.scrollIntoView({ behavior: "smooth", block: "center" }); node.focus();
    }}>Review</button>
  </div>;
}
