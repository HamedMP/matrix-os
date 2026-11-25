/**
 * Navigation and view switching: today, previous, next, the range title, the
 * five views, new event, refresh and the agent panel toggle.
 */
import { Bot, ChevronLeft, ChevronRight, Plus, RefreshCw } from "lucide-react";
import { Toolbar, ToolbarButton, ToolbarGroup, ToolbarSeparator } from "../../../_shared/office-ui";
import { CALENDAR_VIEWS, type CalendarView, type ViewRange } from "../model/ranges";
import { VIEW_LABELS, formatRangeTitle } from "./format";

export interface CalendarToolbarProps {
  range: ViewRange;
  loading: boolean;
  agentOpen: boolean;
  canCreate: boolean;
  onToday(): void;
  onShift(steps: 1 | -1): void;
  onView(view: CalendarView): void;
  onNew(): void;
  onRefresh(): void;
  onToggleAgent(): void;
}

const VIEW_SHORTCUT: Record<CalendarView, string> = { day: "1", workWeek: "2", week: "3", month: "4", agenda: "5" };

export function CalendarToolbar(props: CalendarToolbarProps) {
  const { range } = props;
  const unit = range.view === "month" ? "month" : range.view === "day" ? "day" : range.view === "agenda" ? "period" : "week";
  return (
    <Toolbar label="Calendar">
      <ToolbarGroup label="Create">
        <ToolbarButton label="New event" icon={<Plus size={16} />} showLabel variant="primary" shortcut="C" onClick={props.onNew} disabled={!props.canCreate} />
      </ToolbarGroup>
      <ToolbarSeparator />
      <ToolbarGroup label="Navigate">
        <ToolbarButton label="Today" showLabel shortcut="T" onClick={props.onToday} />
        <ToolbarButton label={`Previous ${unit}`} icon={<ChevronLeft size={16} />} shortcut="P" onClick={() => props.onShift(-1)} />
        <ToolbarButton label={`Next ${unit}`} icon={<ChevronRight size={16} />} shortcut="N" onClick={() => props.onShift(1)} />
      </ToolbarGroup>
      <h2 className="cal-range-title" aria-live="polite">{formatRangeTitle(range)}</h2>
      <ToolbarGroup label="View">
        {CALENDAR_VIEWS.map((view) => (
          <ToolbarButton
            key={view}
            label={VIEW_LABELS[view]}
            showLabel
            pressed={range.view === view}
            shortcut={VIEW_SHORTCUT[view]}
            onClick={() => props.onView(view)}
          />
        ))}
      </ToolbarGroup>
      <ToolbarSeparator />
      <ToolbarGroup label="Tools">
        <ToolbarButton label="Refresh" icon={<RefreshCw size={16} className={props.loading ? "cal-spin" : undefined} />} onClick={props.onRefresh} />
        <ToolbarButton label="Agent" icon={<Bot size={16} />} pressed={props.agentOpen} onClick={props.onToggleAgent} />
      </ToolbarGroup>
    </Toolbar>
  );
}
