import React, { useState } from "react";
import type { UsageSummary } from "@matrix-os/contracts/ai-usage";
import { number } from "./format";
export function UsageHeatmap({
  summary,
  days,
  endDay,
}: {
  summary: UsageSummary;
  days: number;
  endDay: string;
}) {
  const [metric, setMetric] = useState<"tokens" | "requests">("tokens");
  const [detail, setDetail] = useState("");
  const startDay = summary.daily[0]?.day ?? endDay;
  const peak = Math.max(1, ...summary.daily.map((d) => d[metric]));
  const padding = (new Date(`${startDay}T12:00:00Z`).getUTCDay() + 6) % 7;
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
        <select
          aria-label="Activity measure"
          value={metric}
          onChange={(e) => setMetric(e.target.value as "tokens" | "requests")}
        >
          <option value="tokens">Tokens</option>
          <option value="requests">Usage updates</option>
        </select>
      </div>
      <div className="au-chart-scroll">
        <div className="au-months">
          <span>{startDay}</span>
          <span>{endDay}</span>
        </div>
        <div className="au-calendar">
          <div className="au-weekdays">
            <span>Mon</span>
            <span>Wed</span>
            <span>Fri</span>
          </div>
          <div
            className="au-heatmap"
            style={{
              gridTemplateColumns: `repeat(${Math.ceil((days + padding) / 7)}, ${days < 90 ? "10px" : "minmax(5px, 1fr)"})`,
            }}
          >
            {Array.from({ length: padding }, (_, i) => (
              <span key={`pad-${i}`} />
            ))}
            {summary.daily.map((d) => {
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
                  onFocus={() => setDetail(label)}
                  onMouseEnter={() => setDetail(label)}
                  onClick={() => setDetail(label)}
                />
              );
            })}
          </div>
        </div>
      </div>
      <footer>
        <span aria-live="polite">
          {detail || "A record of your activity, one day at a time."}
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
