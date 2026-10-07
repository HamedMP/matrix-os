import { useEffect, useState } from "react";
import { dateText, formatMoney } from "./model";
import type { OwnerRecord } from "./types";
import { contactReview, dailyEvents, invoiceQueue, meetingActions, projectRisks, receiptReview, renewalQueue, text, tripChecks } from "./existing-workflow-model";
import { Actions, Badge, Empty, type ViewProps } from "./views/common";
import Finance from "./views/Finance";
import Agenda from "./views/Agenda";
import Travel from "./views/Travel";
import MeetingBriefs from "./views/MeetingBriefs";
import Board from "./views/Board";
import "./styles/workflow-family.css";
function today() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
function Introduction({ title, detail, symbol }: {
    title: string;
    detail: string;
    symbol: string;
}) {
    return <div className="workflow-introduction">
      <span className="workflow-object" aria-hidden="true">{symbol}
      </span>
      <div>
        <span className="eyebrow">Your next useful step
        </span>
        <h2>{title}
        </h2>
        <p>{detail}
        </p>
      </div>
    </div>;
}
function Reasons({ values }: {
    values: string[];
}) {
    return <ul className="workflow-signals">{values.map(value => <li key={value}>{value}
      </li>)}
    </ul>;
}
function Coverage({ count }: {
    count: number;
}) {
    return count > 20 ?
    <p className="muted">Showing the first 20 of {count} matching records. Use search and account filters to narrow this view.
    </p> : null;
}
function Draft({ record, field, label, button = "Save draft", help, onSave }: {
    record: OwnerRecord;
    field: string;
    label: string;
    button?: string;
    help: string;
    onSave: ViewProps["onSave"];
}) {
    const [value, setValue] = useState(text(record, field));
    const [draftBase, setDraftBase] = useState(record);
    const [dirty, setDirty] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const [saved, setSaved] = useState(false);
    useEffect(() => {
        if (!dirty && !saving) {
            setDraftBase(record);
            setValue(text(record, field));
        }
    }, [record, field, dirty, saving]);
    return <form className="workflow-draft" onSubmit={async (event) => {
            event.preventDefault();
            if (saving)
                return;
            setSaving(true);
            setError("");
            setSaved(false);
            try {
                const manualFields = [...draftBase.manualFields.filter(key => key !== field), field];
                if (manualFields.length > 20)
                    throw new Error("Correction limit reached");
                await onSave({ ...draftBase, fields: { ...draftBase.fields, [field]: value }, manualFields });
                setSaved(true);
                setDirty(false);
            }
            catch (failure) {
                console.error("Workflow draft save failed", failure);
                setError("Could not save. Your draft is still here; try again.");
            }
            finally {
                setSaving(false);
            }
        }}>
      <label>{label}
        <textarea aria-label={label} value={value} maxLength={4000} disabled={saving} onChange={event => { setValue(event.target.value); setSaved(false); setDirty(true); }}/>
      </label>
      <p className="muted">{help}
      </p>
      <div className="draft-save">
        <button disabled={saving}>{saving ? "Saving…" : button}
        </button>{saved &&
        <span role="status">Saved to your records
        </span>}
      </div>{error &&
      <>
        <p className="notice error" role="alert">{error}
        </p>
        <button type="button" onClick={() => { setDirty(false); setError(""); setSaved(false); }}>Discard draft and reload saved text
        </button>
      </>}
    </form>;
}
function ReceiptInbox(props: ViewProps) {
    const review = receiptReview(props.records).filter(row => row.reasons.length);
    return <>
      <section className="workflow-panel" aria-label="Receipt review">
        <Introduction symbol="▤" title="A clearer receipt inbox." detail="Check uncertain receipts before trusting the totals. Possible duplicates stay visible until you review their sources."/>
        <div className="workflow-section-title">
          <h3>Ready for your review
          </h3>
          <span>{review.length} receipts
          </span>
        </div>{review.length ?
        <div className="workflow-review-list">{review.slice(0, 20).map(({ record, reasons }) => <article key={record.id} className="workflow-review-row">
            <div>
              <h3>{text(record, "title") || "Untitled receipt"}
              </h3>
              <Reasons values={reasons}/>
            </div>
            <Actions record={record} {...props}/>
          </article>)}
        </div> :
        <p className="workflow-clear">No receipts in this selection need these checks. Review source evidence if something looks incomplete.
        </p>}
        <Coverage count={review.length}/>
      </section>
      <Finance {...props}/>
    </>;
}
function SubscriptionGuardian(props: ViewProps) {
    const queue = renewalQueue(props.records, today());
    return <>
      <section className="workflow-panel" aria-label="Renewal review">
        <Introduction symbol="↻" title="Stay ahead of your commitments." detail="Confirmed renewal dates lead the queue. A receipt date alone never becomes a renewal or cancellation deadline."/>
        <div className="renewal-queue">{queue.slice(0, 20).map(({ record, renewal, daysUntil, cancelBy, certainty }) => <article key={record.id} className="renewal-row">
            <div className="renewal-day">
              <strong>{daysUntil === null ? "?" : Math.abs(daysUntil)}
              </strong>
              <span>{daysUntil === null ? "date unknown" : daysUntil < 0 ? "days past recorded date" : "days to renewal"}
              </span>
            </div>
            <div>
              <h3>{text(record, "title") || text(record, "provider") || "Subscription"}
              </h3>
              <p>{renewal ? dateText(renewal) : `${certainty} renewal · review the terms`}
              </p>{cancelBy &&
              <p>Recorded cancellation deadline: {dateText(cancelBy)}
              </p>}
            </div>
            <Actions record={record} {...props}/>
          </article>)}
        </div>{!queue.length &&
        <p className="workflow-clear">No active subscriptions in this selection. Add one or review your filters.
        </p>}
        <Coverage count={queue.length}/>
      </section>
      <Finance {...props}/>
    </>;
}
function TodayBrief(props: ViewProps) {
    const [day, setDay] = useState(today());
    const events = dailyEvents(props.records, day);
    return <>
      <section className="workflow-panel today-brief" aria-label="Today brief">
        <Introduction symbol="◷" title="A little clarity for your day." detail="The first three scheduled events for your selected date, in their recorded time order. Missing times and time zones stay explicit."/>
        <label className="brief-date">Brief date
          <input type="date" aria-label="Brief date" value={day} onChange={event => setDay(event.target.value)}/>
        </label>
        <ol className="brief-events">{events.slice(0, 3).map(record => <li key={record.id}>
            <time>{/^([01]\d|2[0-3]):[0-5]\d$/.test(text(record, "time")) ? text(record, "time") : "Time unknown"}
            </time>
            <div>
              <h3>{text(record, "title") || "Untitled event"}
              </h3>
              <p>{text(record, "location") || "Location not recorded"} · {text(record, "timezone") || "Time zone not recorded"}
              </p>{text(record, "priority") &&
              <p>Priority: {text(record, "priority")}
              </p>}
            </div>
            <Actions record={record} {...props}/>
          </li>)}
        </ol>{!events.length &&
        <p className="workflow-clear">No scheduled events with this date in the selected records. This does not imply your connected calendars are empty.
        </p>}{events.length > 3 &&
        <p className="muted">{events.length - 3} more recorded events appear in your agenda below.
        </p>}
      </section>
      <Agenda {...props}/>
    </>;
}
function TripCompanion(props: ViewProps) {
    const active = props.records.filter(record => text(record, "status") !== "Cancelled");
    const [selectedId, setSelectedId] = useState(active[0]?.id || "");
    const record = active.find(item => item.id === selectedId) || active[0];
    return <>
      <section className="workflow-panel trip-preparation" aria-label="Trip preparation">
        <Introduction symbol="✈" title="Arrive with a plan." detail="Review the details your selected bookings actually contain, then keep a personal preparation note. No live flight status is implied."/>{record ?
        <>
          <label>Preparation for
            <select aria-label="Preparation journey" value={record.id} onChange={event => setSelectedId(event.target.value)}>{active.map(item => <option key={item.id} value={item.id}>{text(item, "title") || "Untitled journey"}
              </option>)}
            </select>
          </label>
          <ul className="trip-checks">{tripChecks(record).map(check => <li key={check.label} className={check.ready ? "ready" : "missing"}>
              <span aria-hidden="true">{check.ready ? "✓" : "○"}
              </span>
              <strong>{check.label}
              </strong>
              <small>{check.ready ? "Recorded" : "Needs review"}
              </small>
            </li>)}
          </ul>
          <p className="muted">Travel mode: {text(record, "travel-mode") || "Not recorded"}. Verify dates and references against the original booking.
          </p>
          <Draft key={`${record.id}:preparation`} record={record} field="preparation" label={`Preparation note for ${text(record, "title") || "journey"}`} button="Save preparation" help="A note for your own trip. Saving does not book, cancel or change travel." onSave={props.onSave}/>
          <Actions record={record} {...props}/>
        </> :
        <p className="workflow-clear">Add a journey or choose a different record group to start preparing.
        </p>}
      </section>
      <Travel {...props}/>
    </>;
}
function MeetingFollowThrough(props: ViewProps) {
    const [selectedId, setSelectedId] = useState(props.records[0]?.id || "");
    const record = props.records.find(item => item.id === selectedId) || props.records[0];
    const actions = record ? meetingActions(record.fields.actions) : [];
    return <>
      <section className="workflow-panel" aria-label="Meeting follow-through">
        <Introduction symbol="☷" title="Turn the conversation into next steps." detail="Keep decisions and action ownership together. Missing owners and dates are questions to resolve, not guesses."/>{record ?
        <>
          <label>Action list for
            <select aria-label="Action meeting" value={record.id} onChange={event => setSelectedId(event.target.value)}>{props.records.map(item => <option key={item.id} value={item.id}>{text(item, "title") || "Untitled meeting"}
              </option>)}
            </select>
          </label>{text(record, "decisions") &&
          <div className="meeting-decisions">
            <h3>Recorded decisions
            </h3>
            <p>{text(record, "decisions")}
            </p>
          </div>}
          <ul className="meeting-actions">{actions.map((action, index) => <li key={index}>
              <Badge value={action.status}/>
              <div>
                <h3>{action.task}
                </h3>
                <p>{action.owner || "Owner not recorded"} · {action.due ? dateText(action.due) : "Due date not recorded"}
                </p>
              </div>
            </li>)}
          </ul>{!actions.length &&
          <p className="workflow-clear">No action items recorded for this meeting yet.
          </p>}
          <Draft key={`${record.id}:actions`} record={record} field="actions" label={`Actions for ${text(record, "title") || "meeting"}`} button="Save actions" help="One action per line: Task | Owner | YYYY-MM-DD | Open or Done. You decide ownership and completion; plain notes stay readable." onSave={props.onSave}/>
        </> :
        <p className="workflow-clear">Add a meeting to keep its decisions and next steps together.
        </p>}
      </section>
      <MeetingBriefs {...props}/>
    </>;
}
function KeepInTouch(props: ViewProps) {
    const [reviewOnly, setReviewOnly] = useState(false);
    const all = contactReview(props.records, today());
    const rows = reviewOnly ? all.filter(row => row.identityReview || row.daysSince === null) : all;
    return <section className="workflow-panel" aria-label="Relationship desk">
      <Introduction symbol="◉" title="Keep the people, and the context." detail="Contacts stay separate by record and personal/work scope. A source gap means unknown history; matching names never silently merge."/>
      <label className="workflow-toggle">
        <input type="checkbox" checked={reviewOnly} onChange={event => setReviewOnly(event.target.checked)}/>Show identity or contact-date review
      </label>
      <div className="people-desk">{rows.slice(0, 20).map(({ record, identityReview, last, next, daysSince }) => <article className="person-panel" key={record.id}>
          <div className="person-heading">
            <span className="person-object" aria-hidden="true">{text(record, "title").slice(0, 1) || "?"}
            </span>
            <div>
              <h3>{text(record, "title") || "Unnamed contact"}
              </h3>
              <p>{text(record, "email") || "Email not recorded"}
              </p>
              <span className="badge">{record.scope === "work" ? "Work" : "Personal"}
              </span>
            </div>
          </div>{identityReview &&
          <p className="workflow-caution">Review identity before using this contact for outreach.
          </p>}
          <dl className="relationship-dates">
            <div>
              <dt>Recorded last contact
              </dt>
              <dd>{last ? `${dateText(last)} · ${daysSince} days ago` : "Unknown in these records"}
              </dd>
            </div>
            <div>
              <dt>Your next contact date
              </dt>
              <dd>{next ? dateText(next) : "Not planned"}
              </dd>
            </div>
          </dl>{text(record, "context") &&
          <p>{text(record, "context")}
          </p>}
          <Draft record={record} field="follow-up" label={`Follow-up draft for ${text(record, "title") || "contact"}`} help="Draft only. Review identity and sources before using this text elsewhere." onSave={props.onSave}/>
          <Actions record={record} {...props}/>
        </article>)}
      </div>{!rows.length && (props.records.length ?
      <p className="workflow-clear">No contacts match this review filter. Clear the checkbox to see your other contacts.
      </p> :
      <Empty app={props.app} onAdd={props.onAdd}/>)}
      <Coverage count={rows.length}/>
    </section>;
}
function InvoiceDesk(props: ViewProps) {
    const [lane, setLane] = useState("All");
    const all = invoiceQueue(props.records, today());
    const rows = lane === "All" ? all : all.filter(row => row.lane === lane);
    const overdue = all.filter(row => row.lane === "Overdue");
    const currencies = [...new Set(overdue.map(row => row.currency!))];
    return <section className="workflow-panel invoice-desk" aria-label="Invoice follow-up">
      <Introduction symbol="▧" title="A thoughtful follow-up desk." detail="Overdue means a recorded due date has passed with a known outstanding amount. Disputes, external payments and unknown dates get their own treatment."/>
      <div className="invoice-totals">{currencies.map(currency => <article key={currency}>
          <span>Recorded overdue · {currency}
          </span>
          <strong>{formatMoney(overdue.filter(row => row.currency === currency).reduce((sum, row) => sum + row.outstanding!, 0), currency)}
          </strong>
        </article>)}
      </div>
      <label className="invoice-filter">Invoice queue
        <select aria-label="Invoice queue" value={lane} onChange={event => setLane(event.target.value)}>{["All", "Overdue", "Upcoming", "On hold", "Settled", "Review amount", "Review dates", "Review status"].map(value => <option key={value}>{value}
          </option>)}
        </select>
      </label>
      <div className="invoice-queue">{rows.slice(0, 20).map(({ record, outstanding, currency, due, daysLate, lane: state }) => <article key={record.id} className="invoice-row">
          <div className="invoice-row-title">
            <div>
              <span className={`badge ${state === "Overdue" ? "attention" : ""}`}>{state}
              </span>
              <h3>{text(record, "title") || "Untitled invoice"}
              </h3>
              <p>{text(record, "client") || "Client not recorded"}
              </p>
            </div>
            <div className="invoice-value">
              <strong>{outstanding !== null && currency ? formatMoney(outstanding, currency) : "Amount needs review"}
              </strong>
              <p>{due ? `Due ${dateText(due)}${daysLate !== null && daysLate > 0 ? ` · ${daysLate} days past due` : ""}` : "Due date not recorded"}
              </p>
            </div>
          </div>{state === "Overdue" &&
          <Draft record={record} field="reminder-draft" label={`Reminder draft for ${text(record, "title") || "invoice"}`} help="Draft only. Recheck payment status, recipient and source evidence before sending elsewhere." onSave={props.onSave}/>}
          <Actions record={record} {...props}/>
        </article>)}
      </div>{!rows.length && (props.records.length ?
      <p className="workflow-clear">No invoices match this queue. Choose All to review the other records.
      </p> :
      <Empty app={props.app} onAdd={props.onAdd}/>)}
      <Coverage count={rows.length}/>
    </section>;
}
function ProjectRiskBrief(props: ViewProps) {
    const rows = props.records.map(record => ({ record, flags: projectRisks(record, today()) })).filter(row => row.flags.length);
    return <>
      <section className="workflow-panel" aria-label="Project risk brief">
        <Introduction symbol="▥" title="See what needs a conversation." detail="Recorded blockers, owners and due dates create this brief. Source freshness is checked against an explicit 14-day threshold; merge status does not prove CI or deployment."/>
        <div className="project-risk-grid">{rows.slice(0, 20).map(({ record, flags }) => <article key={record.id}>
            <h3>{text(record, "title") || "Untitled task"}
            </h3>
            <p>{text(record, "project") || "Project not recorded"}
            </p>
            <Reasons values={flags}/>
            <Actions record={record} {...props}/>
          </article>)}
        </div>{!rows.length &&
        <p className="workflow-clear">No recorded risk signals in this selection. Missing source history can still require a check with the team.
        </p>}
        <Coverage count={rows.length}/>
      </section>
      <Board {...props}/>
    </>;
}
export default function ExistingWorkflows(props: ViewProps) {
    switch (props.app.id) {
        case "folio":
            return <ReceiptInbox {...props}/>;
        case "subscriptions":
            return <SubscriptionGuardian {...props}/>;
        case "agenda":
            return <TodayBrief {...props}/>;
        case "atlas":
            return <TripCompanion {...props}/>;
        case "meeting-briefs":
            return <MeetingFollowThrough {...props}/>;
        case "people":
            return <KeepInTouch {...props}/>;
        case "cashflow":
            return <InvoiceDesk {...props}/>;
        case "projects":
            return <ProjectRiskBrief {...props}/>;
        default: return null;
    }
}
