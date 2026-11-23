/**
 * What the conversation list shows when it has no rows: a loading skeleton,
 * a retryable error, or an empty folder or search.
 */
import { AlertCircle, Inbox, SearchX } from "lucide-react";
import { EmptyState, Skeleton } from "../../../_shared/office-ui";
import type { MailState, ThreadView } from "../model";
import { useMailUi } from "./context";

export function ListSkeleton() {
  return (
    <div className="mail-list__skeleton" aria-busy="true" aria-label="Loading conversations">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="mail-row-skeleton"><Skeleton width="40%" /><Skeleton width="85%" /><Skeleton width="65%" /></div>
      ))}
    </div>
  );
}

export function EmptyList({ state, view }: { state: MailState; view: ThreadView }) {
  const { store } = useMailUi();
  if (view.status === "loading" || (view.status === "idle" && !state.cacheLoaded)) return <ListSkeleton />;
  if (view.status === "error") {
    return (
      <div className="mail-list mail-list--state" role="alert">
        <EmptyState
          icon={<AlertCircle />}
          headline="Conversations could not be loaded"
          description={view.error?.message}
          action={{ label: "Try again", onClick: () => void store.refresh() }}
        />
      </div>
    );
  }
  const searching = view.descriptor.kind === "search" || state.filter.trim().length > 0;
  return (
    <div className="mail-list mail-list--state">
      {searching
        ? <EmptyState icon={<SearchX />} headline="No matching conversations" description="Try fewer words or remove a filter." />
        : (
          <EmptyState
            icon={<Inbox />}
            headline="Nothing here"
            description="New conversations in this folder appear here."
            action={{ label: "Refresh", onClick: () => void store.refresh() }}
          />
        )}
    </div>
  );
}

/** A refresh failed while cached rows are still shown. */
export function StaleListNotice({ view }: { view: ThreadView }) {
  const { store } = useMailUi();
  if (!view.error) return null;
  return (
    <div className="mail-pane-error" role="alert">
      <AlertCircle size={14} aria-hidden="true" />
      <span>{view.error.message} Showing saved conversations.</span>
      <button type="button" className="oui-button oui-button--ghost" onClick={() => void store.refresh()}>Retry</button>
    </div>
  );
}
