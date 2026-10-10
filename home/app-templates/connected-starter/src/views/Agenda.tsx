import { useMemo, useState } from "react";
import { agendaGroups, dateText } from "../model";
import { Actions, Badge, Empty, type ViewProps } from "./common";
export default function Agenda(props: ViewProps) {
  const [day, setDay] = useState("");
  const groups = useMemo(() => agendaGroups(props.records), [props.records]);
  const grouped = groups.filter((g) => !day || g.date === day);
  return (
    <>
      <div className="date-nav">
        <h2>Make room for your day.</h2>
        <label>
          View date{" "}
          <input
            aria-label="Agenda date"
            type="date"
            value={day}
            onChange={(e) => setDay(e.target.value)}
          />
        </label>
        {day && <button onClick={() => setDay("")}>All dates</button>}
      </div>
      {!grouped.length ? (
        <Empty app={props.app} onAdd={props.onAdd} />
      ) : (
        <div className="agenda" aria-label="Scheduled timeline">
          {grouped.map((group) => (
            <section key={group.date}>
              <div className="agenda-date">
                <span>
                  {group.date === "Undated" ? "?" : group.date.slice(8)}
                </span>
                <h3>{dateText(group.date)}</h3>
              </div>
              {group.records.map((record) => (
                <article className="agenda-event" key={record.id}>
                  <span className="event-time">
                    {String(record.fields.time ?? "Time to confirm")}
                  </span>
                  <div>
                    <h3>{String(record.fields.title)}</h3>
                    <p>
                      {String(
                        record.fields.location ?? record.fields.people ?? "",
                      )}
                    </p>
                    {record.fields.brief && (
                      <p className="note-excerpt">
                        {String(record.fields.brief)}
                      </p>
                    )}
                    <Actions
                      record={record}
                      onEdit={props.onEdit}
                      onEvidence={props.onEvidence}
                    />
                  </div>
                  <Badge value={record.fields.status} />
                </article>
              ))}
            </section>
          ))}
        </div>
      )}
    </>
  );
}
