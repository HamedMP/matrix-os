import { useState } from "react";
import { dateText } from "../model";
import { Actions, Empty, type ViewProps } from "./common";
export default function MeetingBriefs(props: ViewProps) {
  const [selectedId, setSelectedId] = useState("");
  const selected = props.records.find(r => r.id === selectedId) ?? props.records[0];
  if (!selected) return <Empty app={props.app} onAdd={props.onAdd} />;
  return <div className="briefs-desk">
    <nav className="brief-index" aria-label="Meeting documents"><h2>Preparation</h2>{props.records.map(r => <button key={r.id} aria-label={`Read ${r.fields.title}`} aria-pressed={selected.id === r.id} onClick={() => setSelectedId(r.id)}><small>{dateText(r.fields.date)}</small><strong>{String(r.fields.title)}</strong><span>{String(r.fields.people || "Attendees to confirm")}</span></button>)}</nav>
    <article className="meeting-document" aria-label="Meeting preparation">
      <div className="document-meta"><span>{dateText(selected.fields.date)}</span><span>{String(selected.fields.time || "Time to confirm")}</span></div>
      <h2>{String(selected.fields.title)}</h2><p className="document-people">{String(selected.fields.people || "Add attendees when confirmed.")}</p>
      <section><h3>Before the meeting</h3><p>{String(selected.fields.brief || "Add preparation notes or import relevant source context.")}</p></section>
      <section><h3>Next steps</h3><p>{String(selected.fields.actions || "No next steps recorded yet.")}</p></section>
      {selected.fields.notes && <section><h3>Your notes</h3><p>{String(selected.fields.notes)}</p></section>}
      <Actions record={selected} onEdit={props.onEdit} onEvidence={props.onEvidence} />
    </article>
  </div>;
}
