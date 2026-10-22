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
  onImport?: () => void;
  canImport?: boolean;
  onSave: (r: OwnerRecord) => Promise<unknown>;
  creationScope?: "personal" | "work";
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
  onImport,
  canImport,
  onSave,
  creationScope,
}: Props) {
  return (
    <main>
      <Heading {...{ app, records, visible, canUseRecords, loading, error }} />
      {unavailable && (
        <p className="notice" role="status">
          {unavailable}
        </p>
      )}
      {(error || exportError) && (
        <p className="notice error" role="alert">
          {error || exportError}
        </p>
      )}
      {loading && !records.length && (
        <p className="notice" role="status">
          Loading your saved records…
        </p>
      )}
      {canUseRecords && (
          <Views
            app={app}
            records={visible}
            onEdit={onEdit}
            onEvidence={onEvidence}
            onAdd={onAdd}
            onImport={onImport}
            canImport={canImport}
            onSave={onSave}
            creationScope={creationScope}
          />
        )}
      {limited && <p className="workspace-foot">
        Coverage is limited: showing up to 1,000 active records from the latest 5,000 saved rows. Charts and exports cover the displayed records only.
      </p>}
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
      <h1>{headlines[app.id] || app.name}</h1>
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

const headlines: Record<string, string> = {
  folio: "Spending overview", atlas: "Journeys", agenda: "Agenda",
  subscriptions: "All subscriptions", "meeting-briefs": "Meeting briefs", people: "People",
  cashflow: "Outstanding invoices", projects: "Projects", revenue: "Revenue overview", focus: "Focus",
};
