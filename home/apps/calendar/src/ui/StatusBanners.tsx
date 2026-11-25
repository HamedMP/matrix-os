/**
 * Errors for the current range and the last failed change. Messages are the
 * model's fixed sentences, never provider text.
 */
import type { CalendarState } from "../model";

export interface StatusBannersProps {
  state: CalendarState;
  onRetryEvents(): void;
  onRetryAccounts(): void;
  onDismissMutation(): void;
}

/** The banner stack, or null when there is nothing to report (so the frame shows no empty banner). */
export function statusBanners({ state, onRetryEvents, onRetryAccounts, onDismissMutation }: StatusBannersProps) {
  const banners = [];
  if (state.accountsError && state.accounts.length > 0) {
    banners.push(
      <div key="accounts" className="cal-banner" role="alert">
        <span>Some calendars could not be loaded. {state.accountsError}</span>
        <button type="button" className="oui-button oui-button--ghost" onClick={onRetryAccounts}>Retry</button>
      </div>,
    );
  }
  if (state.eventsStatus === "error") {
    banners.push(
      <div key="events" className="cal-banner" role="alert">
        <span>Events for this range could not be loaded. {state.eventsError}</span>
        <button type="button" className="oui-button oui-button--ghost" onClick={onRetryEvents}>Retry</button>
      </div>,
    );
  }
  if (state.mutationError) {
    banners.push(
      <div key="mutation" className="cal-banner" role="alert">
        <span>{state.mutationError}</span>
        <button type="button" className="oui-button oui-button--ghost" onClick={onDismissMutation}>Dismiss</button>
      </div>,
    );
  }
  return banners.length > 0 ? <div className="cal-banners">{banners}</div> : null;
}
