import { dateText, formatMoney } from "../model";
import { Actions, Badge, Empty, type ViewProps } from "./common";
export default function Commitments(props: ViewProps) {
  return <section className="commitments">
    <div className="section-heading"><h2>Your recurring commitments</h2><span>Every currency and cadence kept separate</span></div>
    {props.records.length ? <ul aria-label="Subscription commitments" className="commitment-list">{props.records.map(record => <li key={record.id}>
      <span className="provider-symbol" aria-hidden="true">{String(record.fields.provider || record.fields.title || "?").slice(0, 1)}</span>
      <div className="commitment-name"><h3>{String(record.fields.title)}</h3><p>{String(record.fields.provider || "Provider to confirm")}</p><Badge value={record.fields.status} /></div>
      <div className="commitment-cost"><strong>{typeof record.fields.amount === "number" && typeof record.fields.currency === "string" ? formatMoney(record.fields.amount, record.fields.currency) : "Amount to confirm"}</strong><span>{String(record.fields.cadence || "Unknown cadence")}</span></div>
      <div className="commitment-date"><small>Recorded date</small><span>{dateText(record.fields.date)}</span></div>
      <Actions record={record} onEdit={props.onEdit} onEvidence={props.onEvidence} />
    </li>)}</ul> : <Empty app={props.app} onAdd={props.onAdd} />}
  </section>;
}
