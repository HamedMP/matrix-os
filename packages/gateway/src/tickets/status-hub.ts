import type { TrackedTicket } from "./contracts.js";

export interface TicketStatusEvent {
  id: string;
  projectSlug: string;
  ticketId: string;
  type: "ticket.created" | "ticket.updated" | "ticket.sync.completed";
  ticket?: TrackedTicket;
  createdAt: string;
}

export interface TicketStatusHub {
  publish(event: TicketStatusEvent): void;
  recent(projectSlug: string, limit?: number): TicketStatusEvent[];
  clear(): void;
}

const MAX_PROJECTS = 100;
const MAX_EVENTS_PER_PROJECT = 200;

export function createTicketStatusHub(): TicketStatusHub {
  const eventsByProject = new Map<string, TicketStatusEvent[]>();

  function touchProject(projectSlug: string): TicketStatusEvent[] {
    const existing = eventsByProject.get(projectSlug);
    if (existing) {
      eventsByProject.delete(projectSlug);
      eventsByProject.set(projectSlug, existing);
      return existing;
    }
    while (eventsByProject.size >= MAX_PROJECTS) {
      const oldest = eventsByProject.keys().next().value as string | undefined;
      if (!oldest) break;
      eventsByProject.delete(oldest);
    }
    const created: TicketStatusEvent[] = [];
    eventsByProject.set(projectSlug, created);
    return created;
  }

  return {
    publish(event) {
      const events = touchProject(event.projectSlug);
      events.push(event);
      if (events.length > MAX_EVENTS_PER_PROJECT) {
        events.splice(0, events.length - MAX_EVENTS_PER_PROJECT);
      }
    },
    recent(projectSlug, limit = 100) {
      return [...(eventsByProject.get(projectSlug) ?? [])].slice(-Math.min(limit, MAX_EVENTS_PER_PROJECT));
    },
    clear() {
      eventsByProject.clear();
    },
  };
}
