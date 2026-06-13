import { useEffect, useRef, useState } from "react";
import { z } from "zod/v4";
import { Activity } from "lucide-react";
import { EmptyState } from "../../design/primitives";
import { toUserMessage } from "../../lib/errors";
import { useConnection } from "../../stores/connection";

const POLL_MS = 5000;

const EventSchema = z.object({
  id: z.string(),
  type: z.string(),
  payload: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.string(),
});
export type TimelineEvent = z.infer<typeof EventSchema>;

/** Human-readable label + accent color for a workspace activity event. */
export function describeEvent(event: TimelineEvent): { label: string; color: string } {
  const p = event.payload ?? {};
  const str = (k: string): string | null => (typeof p[k] === "string" ? (p[k] as string) : null);
  switch (event.type) {
    case "task.created":
      return { label: "Task created", color: "var(--text-secondary)" };
    case "task.updated":
      return { label: str("status") ? `Status → ${str("status")}` : "Task updated", color: "var(--text-secondary)" };
    case "session.started":
      return { label: str("agent") ? `Agent launched (${str("agent")})` : "Session started", color: "var(--success)" };
    case "session.stopped":
      return { label: "Session stopped", color: "var(--text-tertiary)" };
    case "preview.created":
      return { label: "Preview created", color: "var(--highlight)" };
    case "preview.updated":
      return { label: str("lastStatus") === "failed" ? "Preview unhealthy" : "Preview updated", color: "var(--highlight)" };
    case "preview.deleted":
      return { label: "Preview removed", color: "var(--text-tertiary)" };
    default:
      if (event.type.startsWith("review.")) return { label: `Review ${event.type.slice(7).replace(/\./g, " ")}`, color: "var(--accent)" };
      return { label: event.type.replace(/[._]/g, " "), color: "var(--text-secondary)" };
  }
}

/** Compact relative time ("now", "3m", "2h", "5d") from an ISO string. */
export function relativeTime(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const sec = Math.max(0, Math.floor((now - then) / 1000));
  if (sec < 45) return "now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

export default function TimelinePanel({ taskId }: { taskId: string }) {
  const api = useConnection((s) => s.api);
  const [events, setEvents] = useState<TimelineEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const inFlight = useRef(false);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    const tick = async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const res = await api.get<{ events?: unknown[] }>(
          `/api/workspace/events?taskId=${encodeURIComponent(taskId)}&limit=50`,
        );
        if (cancelled) return;
        const parsed: TimelineEvent[] = [];
        for (const raw of res.events ?? []) {
          const r = EventSchema.safeParse(raw);
          if (r.success) parsed.push(r.data);
        }
        // Newest first.
        parsed.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
        setEvents(parsed);
        setNow(Date.now());
        setError(null);
      } catch (err: unknown) {
        if (!cancelled) {
          setError(toUserMessage(err));
          setEvents((prev) => prev ?? []);
        }
      } finally {
        inFlight.current = false;
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [api, taskId]);

  if (events === null) {
    return <div className="flex flex-1 items-center justify-center text-sm" style={{ color: "var(--text-tertiary)" }}>Loading activity…</div>;
  }
  if (events.length === 0) {
    return (
      <EmptyState
        icon={<Activity size={22} />}
        headline="No activity yet"
        description={error ?? "Start a session or agent and this task's activity will appear here."}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto p-2">
      {events.map((event) => {
        const { label, color } = describeEvent(event);
        return (
          <div key={event.id} className="flex items-start gap-2.5 rounded-md px-2 py-1.5">
            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />
            <span className="min-w-0 flex-1 text-sm" style={{ color: "var(--text-primary)" }}>{label}</span>
            <span className="shrink-0 text-xs tabular-nums" style={{ color: "var(--text-tertiary)" }}>{relativeTime(event.createdAt, now)}</span>
          </div>
        );
      })}
    </div>
  );
}
