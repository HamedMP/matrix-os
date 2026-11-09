import React from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../Select";
export function UsageSelect({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger aria-label={label} className="au-select-trigger">
        <SelectValue />
      </SelectTrigger>
      <SelectContent
        className="ph-no-capture"
        position="popper"
        align="start"
        sideOffset={4}
      >
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

import type { UsageAgent, UsageHistory } from "@matrix-os/contracts/ai-usage";
const recentRanges = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "365", label: "Last year" },
];
function dateRanges(history?: UsageHistory) {
  if (!history) return recentRanges;
  return history.reports
    .filter((r) => r.agent === "")
    .map((r) => ({
      value: r.id,
      label: r.id === "all" ? "All recovered coding history" : r.label,
    }));
}
export function UsageFilters({
  agent,
  range,
  history,
  onAgent,
  onRange,
}: {
  agent: UsageAgent | "";
  range: string;
  history?: UsageHistory;
  onAgent: (value: UsageAgent | "") => void;
  onRange: (value: string) => void;
}) {
  return (
    <div className="au-toolbar">
      <div className="au-filter">
        <UsageSelect
          label="Coding agent"
          value={agent || "all"}
          options={[
            { value: "all", label: "All agents" },
            { value: "claude", label: "Claude Code" },
            { value: "codex", label: "Codex" },
          ]}
          onChange={(value) =>
            onAgent(value === "all" ? "" : (value as UsageAgent))
          }
        />
        <UsageSelect
          label="Date range"
          value={range}
          onChange={onRange}
          options={dateRanges(history)}
        />
      </div>
      <span>◉ Only you can see this</span>
    </div>
  );
}
