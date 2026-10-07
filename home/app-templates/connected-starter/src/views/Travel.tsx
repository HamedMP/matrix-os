import { useState } from "react";
import { dateText } from "../model";
import { Actions, Badge, Empty, type ViewProps } from "./common";
import DestinationMap, { cityLocation } from "./DestinationMap";
export default function Travel(props: ViewProps) {
  const [selectedId, setSelectedId] = useState("");
  const selected = props.records.find(r => r.id === selectedId) ?? props.records[0];
  if (!selected) return <Empty app={props.app} onAdd={props.onAdd} />;
  const destination = String(selected.fields.destination ?? "Destination to confirm");
  return <div className="atlas-canvas">
    <section className="destination-canvas" aria-label="Journey destinations">
      <div className="destination-title"><span>Your world of plans</span><h2>{destination}</h2><p>{dateText(selected.fields.date)}</p></div>
      <DestinationMap records={props.records} selected={selected} onSelect={setSelectedId} />
      <p className="map-caption">Schematic world map · known city locations{!cityLocation(destination) && <strong>Location not mapped</strong>}</p>
    </section>
    <div className="atlas-bottom">
      <nav className="journey-picker" aria-label="Choose a journey">
        <h3>Your journeys</h3>
        {props.records.map(record => <button key={record.id} aria-label={`View ${record.fields.title}`} aria-pressed={record.id === selected.id} onClick={() => setSelectedId(record.id)}>
          <span className="journey-place">{String(record.fields.destination ?? "Destination to confirm")}</span>
          <strong>{String(record.fields.title)}</strong><small>{dateText(record.fields.date)}</small>
        </button>)}
      </nav>
      <section className="journey-detail" aria-label="Selected journey">
        <div className="card-top"><span>Itinerary</span><Badge value={selected.fields.status} /></div>
        <h2>{String(selected.fields.title)}</h2>
        <div className="journey-dates"><div><small>Departure</small><strong>{dateText(selected.fields.date)}</strong></div><span aria-hidden="true">→</span><div><small>Return</small><strong>{dateText(selected.fields["end-date"])}</strong></div></div>
        <dl className="journey-facts"><div><dt>Flight</dt><dd>{String(selected.fields.flight || "To confirm")}</dd></div><div><dt>Booking</dt><dd>{String(selected.fields.booking || "To confirm")}</dd></div></dl>
        {selected.fields.notes && <p className="journey-notes">{String(selected.fields.notes)}</p>}
        <Actions record={selected} onEdit={props.onEdit} onEvidence={props.onEvidence} />
      </section>
    </div>
  </div>;
}
