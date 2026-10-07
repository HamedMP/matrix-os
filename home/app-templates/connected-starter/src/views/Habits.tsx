import { Empty, type ViewProps } from "./common";
const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" });
export default function Habits(props: ViewProps) {
  const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date();
      d.setDate(d.getDate() - 6 + i);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }),
    titles = Array.from(
      new Set(props.records.map((r) => String(r.fields.title))),
    );
  return (
    <>
      <div className="section-heading">
        <div>
          <h2>A week of small steps.</h2>
          <p className="muted">Each entry is an actual dated check-in.</p>
        </div>
        <button onClick={props.onAdd}>Add check-in</button>
      </div>
      {titles.length ? (
        <div className="habit-table">
          <table>
            <thead>
              <tr>
                <th>Habit</th>
                {days.map((d) => (
                  <th key={d}>
                    {weekday.format(new Date(d + "T12:00:00"))}
                    <small>{d.slice(8)}</small>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {titles.map((title) => (
                <tr key={title}>
                  <th>{title}</th>
                  {days.map((day) => {
                    const found = props.records.find(
                      (r) => r.fields.title === title && r.fields.date === day,
                    );
                    return (
                      <td key={day}>
                        {found ? (
                          <button
                            className={`habit-mark ${found.fields.status === "Done" ? "done" : ""}`}
                            onClick={() => props.onEdit(found)}
                            aria-label={`${title} ${day}: ${found.fields.status ?? "Unknown"}`}
                          >
                            {found.fields.status === "Done"
                              ? "✓"
                              : found.fields.status === "Skipped"
                                ? "—"
                                : "◌"}
                          </button>
                        ) : (
                          <span className="habit-gap" title="No check-in">
                            ·
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty app={props.app} onAdd={props.onAdd} />
      )}
    </>
  );
}
