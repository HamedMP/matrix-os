import { Card, type ViewProps } from "./common";
export default function Board(props: ViewProps) {
  const options =
      props.app.fields.find((f) => f.key === "status")?.options ?? [],
    allowed = new Set(options),
    unclassified = props.records.filter(
      (r) => !allowed.has(String(r.fields.status)),
    );
  return (
    <div className="board">
      {[
        ...options,
        ...(unclassified.length || !options.length ? ["Unclassified"] : []),
      ].map((status) => {
        const rows = props.records.filter((r) =>
          status === "Unclassified"
            ? !allowed.has(String(r.fields.status))
            : r.fields.status === status,
        );
        return (
          <section className="board-column" key={status}>
            <header>
              <span className="tiny-dot" />
              <h3>{status}</h3>
              <span>{rows.length}</span>
            </header>
            {rows.map((record) => (
              <Card key={record.id} record={record} {...props} />
            ))}
            {!rows.length && (
              <p className="column-empty">No {props.app.entity}s here yet.</p>
            )}
            <button className="column-add" onClick={props.onAdd}>
              + Add {props.app.entity}
            </button>
          </section>
        );
      })}
    </div>
  );
}
