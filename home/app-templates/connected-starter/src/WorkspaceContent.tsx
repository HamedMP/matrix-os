import Views from "./Views";
import type { Definition, OwnerRecord } from "./types";
interface Props {
  app: Definition;
  records: OwnerRecord[];
  visible: OwnerRecord[];
  error: string;
  exportError: string;
  loading: boolean;
  limited: boolean;
  unavailable: string;
  canUseRecords: boolean;
  onEdit: (r: OwnerRecord) => void;
  onEvidence: (r: OwnerRecord) => void;
  onAdd: () => void;
  onSave: (r: OwnerRecord) => Promise<unknown>;
}
export default function WorkspaceContent({
  app,
  records,
  visible,
  error,
  exportError,
  loading,
  limited,
  unavailable,
  canUseRecords,
  onEdit,
  onEvidence,
  onAdd,
  onSave,
}: Props) {
  return (
    <main>
      <Heading {...{ app, records, visible, canUseRecords, loading, error }} />
      {unavailable && (
        <p className="notice" role="status">
          {unavailable}
        </p>
      )}
      {!unavailable && (error || exportError) && (
        <p className="notice error" role="alert">
          {error || exportError}
        </p>
      )}
      {loading && !records.length && (
        <p className="notice" role="status">
          Loading your saved records…
        </p>
      )}
      {canUseRecords &&
        (app.view === "focus" || records.length > 0 || !(loading || error)) && (
          <Views
            app={app}
            records={visible}
            onEdit={onEdit}
            onEvidence={onEvidence}
            onAdd={onAdd}
            onSave={onSave}
          />
        )}
      <p className="workspace-foot">
        {app.services.length
          ? "Source-backed imports and your own notes, together."
          : "A space built from your own entries."}{" "}
        {limited
          ? "Coverage is limited: showing up to 1,000 active records from the latest 5,000 saved rows. Charts and exports cover the displayed records only."
          : ""}
      </p>
    </main>
  );
}

function Heading({
  app,
  records,
  visible,
  canUseRecords,
  loading,
  error,
}: Pick<
  Props,
  "app" | "records" | "visible" | "canUseRecords" | "loading" | "error"
>) {
  return (
    <section className="page-heading">
      <div>

        <h1>{app.id === "atlas" ? "Places to look forward to." : app.id === "folio" ? "A clear view of your spending." : app.id === "focus" ? "Your attention, here." : app.id === "agenda" ? "A day with room to think." : app.id === "meeting-briefs" ? "Walk in prepared." : app.id === "subscriptions" ? "Know what keeps coming around." : app.id === "projects" ? "Good work, moving forward." : app.id === "revenue" ? "Money coming in." : app.name}</h1>
        <p>{app.description}</p>
      </div>
      <div className="record-count">
        <strong>
          {canUseRecords && !loading && !error
            ? visible.length
            : records.length
              ? visible.length
              : "—"}
        </strong>
        <span>
          {app.entity}
          {visible.length === 1 ? "" : "s"}
        </span>
      </div>
    </section>
  );
}
