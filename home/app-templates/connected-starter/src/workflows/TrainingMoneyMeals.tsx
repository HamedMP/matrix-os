import { useMemo, useRef, useState } from "react";
import type { ViewProps } from "../views/common";
import type { OwnerRecord } from "../types";
import { formatMoney, dateText, validDate } from "../model";
import { workoutHistory, planRunway, mealGroceries, newRecord } from "./models";
import { Intro, EmptyHint, RecordActions, SaveError, useSavedAction, localDate, plusDays, MiniTrend, useCreationScope, CreationGroup } from "./Shared";

export function Workout(props: ViewProps) {
  const [exercise, setExercise] = useState(""), [weight, setWeight] = useState(""), [reps, setReps] = useState(""), [date, setDate] = useState(localDate), [unit, setUnit] = useState("kg"), [kind, setKind] = useState("Working");
  const draftId = useRef(crypto.randomUUID()), saved = useSavedAction(props.onSave);
  const group = useCreationScope(props.creationScope);
  const history = useMemo(() => workoutHistory(props.records), [props.records]);
  async function log(event: React.FormEvent) {
    event.preventDefault();
    if (!exercise.trim() || !weight || !reps || !validDate(date) || Number(weight) < 0 || Number(weight) > 1500 || !Number.isInteger(Number(reps)) || Number(reps) < 1 || Number(reps) > 200) { saved.setError("Enter an exercise, valid date, load from 0–1,500 and 1–200 whole reps."); return; }
    const record = { ...newRecord({ title: `${exercise.trim()} set`, exercise: exercise.trim(), date, weight: Number(weight), reps: Number(reps), unit, "set-type": kind }, group.scope), id: draftId.current };
    if (await saved.save(record)) { draftId.current = crypto.randomUUID(); setWeight(""); setReps(""); }
  }
  return <div className="new-workflow nw-training"><Intro title="Your work, set by set." detail="Log the load you used. Progress comes from saved working sets; warmups stay in the log." />
    <form className="nw-set-log" onSubmit={event => void log(event)}><CreationGroup {...group} disabled={saved.busy} /><label>Exercise<input value={exercise} maxLength={200} onChange={event => setExercise(event.target.value)} placeholder="e.g. Squat" disabled={saved.busy} required /></label><label>Date<input type="date" value={date} onChange={event => setDate(event.target.value)} disabled={saved.busy} required /></label><label>Load<input type="number" value={weight} min={0} max={1500} step="any" onChange={event => setWeight(event.target.value)} disabled={saved.busy} required /></label><label>Unit<select value={unit} onChange={event => setUnit(event.target.value)} disabled={saved.busy}><option>kg</option><option>lb</option></select></label><label>Reps<input type="number" value={reps} min={1} max={200} onChange={event => setReps(event.target.value)} disabled={saved.busy} required /></label><label>Set type<select value={kind} onChange={event => setKind(event.target.value)} disabled={saved.busy}><option>Working</option><option>Warmup</option></select></label><button className="primary" disabled={saved.busy}>{saved.busy ? "Saving…" : "Save set"}</button></form>
    <SaveError error={saved.error} />
    <div className="nw-progress-grid">{history.exercises.map(group => <article className="nw-training-page" key={group.exercise}><h3>{group.exercise}</h3><div className="nw-training-numbers"><p><strong>{group.heaviestKg.toFixed(1)}<small> kg</small></strong><span>Heaviest working set</span></p><p><strong>{group.volumeKg.toFixed(0)} kg</strong><span>Total load × reps</span></p></div><MiniTrend values={group.trend.map(day => ({ label: day.date, value: day.volumeKg }))} label={`${group.exercise} working volume in kg`} /><p className="muted">{group.sets} working sets · All loads normalized to kg.</p></article>)}</div>
    {!history.exercises.length && <EmptyHint>Save a working set to start your actual volume and heaviest-set history.</EmptyHint>}
    {(history.warmups > 0 || history.unconfirmed > 0) && <p className="nw-footnote">{history.warmups} warmups outside progress totals. {history.unconfirmed} sets need confirmed exercise, date, units or reps.</p>}
    <section className="nw-ledger"><h3>Saved set log</h3>{props.records.slice(0, 1000).map(record => <article className="nw-log-row" key={record.id}><div><strong>{String(record.fields.exercise ?? record.fields.title ?? "Exercise")}</strong><p>{dateText(record.fields.date)} · {String(record.fields["set-type"] ?? "Set type to confirm")}</p></div><span>{String(record.fields.weight ?? "?")} {String(record.fields.unit ?? "?")} × {String(record.fields.reps ?? "?")}</span><RecordActions record={record} {...props} /></article>)}</section>
  </div>;
}

export function Runway(props: ViewProps) {
  const [today, setToday] = useState(localDate), [payday, setPayday] = useState(() => plusDays(localDate(), 14));
  const result = useMemo(() => { try { return { plan: planRunway(props.records, { today, payday }), error: "" }; } catch (error) { return { plan: [], error: "Choose valid dates with payday on or after today." }; } }, [props.records, today, payday]);
  return <div className="new-workflow nw-runway"><Intro title="Give this payday a plan." detail="Allocate confirmed cash to dated bills and reserves. Future pay never increases the money available today." action={<button className="primary" onClick={props.onAdd}>Add cash or commitment</button>} />
    <div className="nw-period"><label>Cash as of<input type="date" value={today} onChange={event => setToday(event.target.value)} /></label><label>Next payday<input type="date" value={payday} min={today} onChange={event => setPayday(event.target.value)} /></label></div><SaveError error={result.error} />
    {result.plan.map(group => <section className="nw-cash-plan" key={`${group.scope}-${group.currency}`}><header><h3>{group.currency} <small>{group.scope === "work" ? "Work" : "Personal"}</small></h3><p>{group.opening ? `Opening snapshot: ${dateText(group.opening.fields.date)}` : "Add a confirmed opening balance for this currency."}</p></header><div className="nw-money-summary"><p><span>Confirmed cash</span><strong>{formatMoney(group.available, group.currency)}</strong></p><p><span>To cover by payday</span><strong>{formatMoney(group.required, group.currency)}</strong></p><p className={group.shortfall ? "nw-shortfall" : ""}><span>{group.shortfall ? "Still to cover" : "Unallocated cash"}</span><strong>{formatMoney(group.shortfall || group.remaining, group.currency)}</strong></p></div><ol className="nw-cash-timeline">{group.allocations.map(item => <li key={item.record.id}><time>{dateText(item.record.fields.date)}</time><div><h4>{String(item.record.fields.title ?? "Commitment")}</h4><p>{formatMoney(item.allocated, group.currency)} allocated{item.shortfall > 0 ? ` · ${formatMoney(item.shortfall, group.currency)} still to cover` : " · Covered"}</p><RecordActions record={item.record} {...props} /></div><div className="nw-allocation-track" aria-label={`${item.allocated} allocated of ${item.record.fields.amount}`}><span style={{ width: `${Number(item.record.fields.amount) > 0 ? item.allocated / Number(item.record.fields.amount) * 100 : 100}%` }} /></div></li>)}</ol></section>)}
    {!result.plan.length && <EmptyHint>Add your opening cash, currency and date, then the bills it needs to cover. Estimates remain outside confirmed allocations.</EmptyHint>}
    <details className="nw-record-details"><summary>All cash, income and commitments ({props.records.length})</summary>{props.records.slice(0, 1000).map(record => <article className="nw-log-row" key={record.id}><div><strong>{String(record.fields.title ?? "Record")}</strong><p>{String(record.fields.kind ?? "Kind to confirm")} · {String(record.fields.status ?? "Unconfirmed")} · {dateText(record.fields.date)}</p></div><span>{String(record.fields.amount ?? "?")} {String(record.fields.currency ?? "")}</span><RecordActions record={record} {...props} /></article>)}</details>
    <p className="nw-footnote">Each currency and Personal/Work group has its own latest opening snapshot. Received income after that snapshot is added. Confirmed overdue unpaid bills stay in the plan; bills already paid are excluded.</p>
  </div>;
}

export function Meals(props: ViewProps) {
  const [portions, setPortions] = useState(2), [week, setWeek] = useState(localDate), [rotation, setRotation] = useState<OwnerRecord[]>([]), [savedCount, setSavedCount] = useState(0);
  const saved = useSavedAction(props.onSave), batch = useRef(false);
  const recipes = props.records.filter(record => record.fields.status === "Recipe").slice(0, 100);
  const allPlanned = props.records.filter(record => record.fields.status === "Planned").sort((a, b) => String(a.fields.date).localeCompare(String(b.fields.date)));
  const weekEnd = validDate(week) ? plusDays(week, 6) : "";
  const planned = allPlanned.filter(record => validDate(record.fields.date) && String(record.fields.date) >= week && String(record.fields.date) <= weekEnd);
  const otherPlanned = allPlanned.filter(record => !planned.includes(record));
  const groceries = useMemo(() => mealGroceries(planned), [props.records, week]);
  function preview() {
    if (!recipes.length || !validDate(week) || !Number.isInteger(portions) || portions < 1 || portions > 20) { saved.setError("Save a familiar recipe and choose a valid start date and 1–20 portions."); return; }
    setSavedCount(0); setRotation(Array.from({ length: 7 }, (_, index) => {
      const source = recipes[index % recipes.length];
      return { ...newRecord({ ...source.fields, date: plusDays(week, index), "planned-portions": portions, status: "Planned", pantry: null }, source.scope), sources: source.sources, accounts: source.accounts };
    })); saved.setError("");
  }
  async function saveRotation() {
    if (batch.current) return;
    batch.current = true;
    try {
      for (let index = savedCount; index < rotation.length; index++) { if (!(await saved.save(rotation[index]))) return; setSavedCount(index + 1); }
      setRotation([]); setSavedCount(0);
    } finally { batch.current = false; }
  }
  return <div className="new-workflow nw-meals"><Intro title="A week of food you know." detail="Save familiar recipes, review a rotation and scale the grocery list to the portions you plan to cook." action={<button className="primary" onClick={props.onAdd}>Add meal</button>} />
    <p className="nw-format-help">Ingredient format: <code>rice | 200 | g</code>, one per line. Pantry quantities are allocated to that one planned meal, not a shared stock estimate.</p>
    <div className="nw-meal-layout"><section><div className="nw-period"><label>Week starts<input type="date" value={week} onChange={event => setWeek(event.target.value)} disabled={saved.busy} /></label><label>Portions each meal<input type="number" min={1} max={20} value={portions} onChange={event => setPortions(Number(event.target.value))} disabled={saved.busy} /></label><button onClick={preview} disabled={saved.busy || rotation.length > 0}>Preview seven-day rotation</button></div><SaveError error={saved.error} />
    {rotation.length > 0 && <div className="nw-rotation-review"><h3>Review before saving</h3>{rotation.map((meal, index) => <p key={meal.id}>{meal.fields.date}: {String(meal.fields.title)} · {portions} portions {index < savedCount ? "— Saved" : ""}</p>)}<button className="primary" onClick={() => void saveRotation()} disabled={saved.busy}>{saved.busy ? "Saving meal…" : savedCount ? "Retry remaining meals" : "Save this rotation"}</button>{savedCount === 0 && <button onClick={() => setRotation([])} disabled={saved.busy}>Discard preview</button>}</div>}
    {!weekEnd && <SaveError error="Choose a valid week start to see your meals and grocery list." />}
    <div className="nw-meal-week">{planned.map(meal => <article key={meal.id}><time>{dateText(meal.fields.date)}</time><h3>{String(meal.fields.title)}</h3><p>{String(meal.fields["planned-portions"] ?? "?")} planned portions · recipe serves {String(meal.fields.servings ?? "?")}</p><RecordActions record={meal} {...props} /></article>)}</div>
    {!planned.length && <EmptyHint>Choose Recipe when saving a familiar meal. Preview a rotation, then save it to create your dated cooking plan.</EmptyHint>}
    <details className="nw-record-details"><summary>Other saved meal plans ({otherPlanned.length})</summary>{otherPlanned.map(meal => <article className="nw-log-row" key={meal.id}><div><strong>{String(meal.fields.title)}</strong><p>{dateText(meal.fields.date)}</p></div><RecordActions record={meal} {...props} /></article>)}</details>
    <details className="nw-record-details"><summary>Familiar recipes ({recipes.length})</summary>{recipes.map(meal => <article className="nw-log-row" key={meal.id}><strong>{String(meal.fields.title)}</strong><RecordActions record={meal} {...props} /></article>)}</details>
    {props.records.some(meal => !["Recipe", "Planned"].includes(String(meal.fields.status))) && <section className="nw-record-details"><h3>Meals to classify</h3><p>Choose Recipe or Planned to include these in your rotation or grocery list.</p>{props.records.filter(meal => !["Recipe", "Planned"].includes(String(meal.fields.status))).map(meal => <article className="nw-log-row" key={meal.id}><strong>{String(meal.fields.title)}</strong><RecordActions record={meal} {...props} /></article>)}</section>}</section>
    <aside className="nw-grocery-paper"><h3>Your grocery list</h3><p>From the saved meals in your selected seven days.</p>{groceries.items.length ? <ul>{groceries.items.map(item => <li key={`${item.name}-${item.unit}`}><span>{item.name}</span><strong>{Number(item.quantity.toFixed(2))} {item.unit}</strong></li>)}</ul> : <p className="nw-empty">Save a planned meal with quantities to start a merged list.</p>}{groceries.issues.length > 0 && <details><summary>{groceries.issues.length} ingredient details to review</summary>{groceries.issues.map((issue, index) => <p key={index}>{issue}</p>)}</details>}<p className="nw-footnote">Grams and kilograms merge; millilitres and litres merge. Cups and weights remain separate.</p></aside></div>
  </div>;
}
