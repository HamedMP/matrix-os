import React, { useMemo, useState } from "react";
import type { UsageSummary } from "@matrix-os/contracts/ai-usage";
import { UsageSelect } from "./UsageSelect";
import { number } from "./format";
type Day = UsageSummary["daily"][number];
type Calendar = { year: string; days: Day[] };
function calendarRows(daily: Day[], split: boolean) {
  const rows: Calendar[] = [];
  for (const day of daily) {
    const year = split ? day.day.slice(0, 4) : "selected";
    if (rows.at(-1)?.year !== year) rows.push({ year, days: [] });
    rows.at(-1)!.days.push(day);
  }
  return rows;
}
function CalendarRow({
  row,
  metric,
  peak,
  cell,
  onDetail,
}: {
  row: Calendar;
  metric: "tokens" | "requests";
  peak: number;
  cell: number;
  onDetail: (value: string) => void;
}) {
  const first = row.days[0]!.day,
    last = row.days.at(-1)!.day;
  const padding = (new Date(`${first}T12:00:00Z`).getUTCDay() + 6) % 7;
  return (
    <div className="au-chart-scroll">
      <div
        className="au-calendar-block"
        role="group"
        aria-label={`${row.year === "selected" ? "Selected period" : row.year} activity`}
      >
        {row.year !== "selected" && <h4>{row.year}</h4>}
        <div className="au-months">
          <time>{first}</time>
          <time>{last}</time>
        </div>
        <div className="au-calendar">
          <div
            className="au-weekdays"
            style={{ gridTemplateRows: `repeat(7, ${cell}px)` }}
          >
            <span>Mon</span>
            <span>Wed</span>
            <span>Fri</span>
          </div>
          <div
            className="au-heatmap"
            style={{
              gridTemplateColumns: `repeat(${Math.ceil((row.days.length + padding) / 7)}, ${cell}px)`,
              gridTemplateRows: `repeat(7, ${cell}px)`,
            }}
          >
            {Array.from({ length: padding }, (_, i) => (
              <span key={`pad-${i}`} />
            ))}
            {row.days.map((d) => {
              const level =
                d[metric] === 0
                  ? 0
                  : Math.min(4, Math.ceil((d[metric] / peak) * 4));
              const label =
                d.requests === 0
                  ? `${d.day}: no recorded usage; history may be unavailable`
                  : `${d.day}: ${number(d.tokens)} tokens, ${number(d.requests)} usage updates`;
              return (
                <button
                  type="button"
                  className={`au-day au-level-${level}`}
                  key={d.day}
                  title={label}
                  aria-label={label}
                  onFocus={() => onDetail(label)}
                  onMouseEnter={() => onDetail(label)}
                  onClick={() => onDetail(label)}
                />
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
export function UsageHeatmap({
  summary,
  days,
  endDay,
}: {
  summary: UsageSummary;
  days: number;
  endDay: string;
}) {
  const [metric, setMetric] = useState<"tokens" | "requests">("tokens"),
    [detail, setDetail] = useState("");
  const rows = useMemo(
    () => calendarRows(summary.daily, days > 366),
    [summary.daily, days],
  );
  const peak = Math.max(1, ...summary.daily.map((d) => d[metric]));
  return (
    <article className="au-activity">
      <div className="au-section-head">
        <div>
          <h3>Activity</h3>
          <p>
            {number(summary.tokens)} tokens over {summary.activeDays} active
            days
          </p>
        </div>
        <UsageSelect label="Activity measure" value={metric} onChange={value=>setMetric(value as "tokens"|"requests")} options={[{value:"tokens",label:"Tokens"},{value:"requests",label:"Usage updates"}]}/>
      </div>
      <div
        className="au-calendar-years"
        aria-label={`Daily coding activity through ${endDay}`}
      >
        {rows.map((row) => (
          <CalendarRow
            key={row.year}
            row={row}
            metric={metric}
            peak={peak}
            cell={days <= 90 ? 16 : 12}
            onDetail={setDetail}
          />
        ))}
      </div>
      <footer>
        <span aria-live="polite">
          {detail || "A record of recovered counters, one day at a time."}
        </span>
        <span className="au-legend">
          Less{" "}
          {[0, 1, 2, 3, 4].map((i) => (
            <i key={i} className={`au-level-${i}`} />
          ))}{" "}
          More
        </span>
      </footer>
    </article>
  );
}
