import { dateText } from "../model";
import { Actions, Badge, Empty, type ViewProps } from "./common";
export default function Travel(props: ViewProps) {
  return props.records.length ? (
    <div className="travel-list">
      {props.records.map((record) => (
        <article className="trip-journey" key={record.id}>
          <div className="route-mark" aria-hidden="true">
            <span>◌</span>
            <i />
            <span>↗</span>
          </div>
          <div>
            <div className="card-top">
              <span className="eyebrow">
                {String(record.fields.destination ?? "Destination to confirm")}
              </span>
              <Badge value={record.fields.status} />
            </div>
            <h2>{String(record.fields.title)}</h2>
            <div className="journey-dates">
              <div>
                <small>Departure</small>
                <strong>{dateText(record.fields.date)}</strong>
              </div>
              <span>→</span>
              <div>
                <small>Return</small>
                <strong>{dateText(record.fields["end-date"])}</strong>
              </div>
            </div>
            {record.fields.flight && (
              <p>Flight {String(record.fields.flight)}</p>
            )}
            {record.fields.booking && (
              <p>Booking {String(record.fields.booking)}</p>
            )}
            {record.fields.notes && (
              <p className="note-excerpt">{String(record.fields.notes)}</p>
            )}
            <Actions
              record={record}
              onEdit={props.onEdit}
              onEvidence={props.onEvidence}
            />
          </div>
        </article>
      ))}
    </div>
  ) : (
    <Empty app={props.app} onAdd={props.onAdd} />
  );
}
