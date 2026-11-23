/**
 * A stand-in for the injected `window.MatrixOS` bridge, for mounting the real
 * Calendar app. It answers `service("google_calendar", ...)` with Google
 * Calendar API v3 JSON, keeps app tables in memory and records every call.
 * It fakes the platform, not the app: the app's own providers, store and UI
 * run unchanged on top of it.
 */
type Row = Record<string, unknown> & { id: string };

export interface ServiceCall {
  service: string;
  action: string;
  params: Record<string, unknown>;
  label: string | undefined;
}

export interface GoogleEventJson {
  id: string;
  summary: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
  status?: string;
  organizer?: { email: string; self?: boolean };
  attendees?: Array<{ email: string; displayName?: string; self?: boolean; organizer?: boolean; responseStatus: string }>;
  location?: string;
}

export const OWNER = "me@example.com";
export const PRIMARY = OWNER;
export const HOLIDAYS = "en.usa#holiday@group.v.calendar.google.com";

/** Calendar list reply: the owner's primary calendar and a read-only holiday calendar. */
export const CALENDAR_LIST = {
  kind: "calendar#calendarList",
  etag: "\"p33k9lr0s0g6o0g\"",
  items: [
    {
      kind: "calendar#calendarListEntry",
      id: PRIMARY,
      summary: PRIMARY,
      timeZone: "America/New_York",
      colorId: "14",
      backgroundColor: "#9fe1e7",
      foregroundColor: "#000000",
      selected: true,
      accessRole: "owner",
      primary: true,
    },
    {
      kind: "calendar#calendarListEntry",
      id: HOLIDAYS,
      summary: "Holidays in United States",
      timeZone: "America/New_York",
      colorId: "8",
      backgroundColor: "#16a765",
      selected: true,
      accessRole: "reader",
    },
  ],
};

function startMs(part: GoogleEventJson["start"]): number {
  return Date.parse(part.dateTime ?? `${part.date}T00:00:00Z`);
}

function overlaps(event: GoogleEventJson, timeMin: string, timeMax: string): boolean {
  return startMs(event.start) < Date.parse(timeMax) && startMs(event.end) > Date.parse(timeMin);
}

export class FakeMatrixOS {
  readonly calls: ServiceCall[] = [];
  readonly prompts: string[] = [];
  readonly tables: Record<string, Row[]> = { calendar_preferences: [], calendar_proposals: [] };
  /** Events per calendar id, as Google stores them. */
  readonly events: Record<string, GoogleEventJson[]> = { [PRIMARY]: [], [HOLIDAYS]: [] };
  /** Busy intervals per address for `free_busy`. */
  busy: Record<string, Array<{ start: string; end: string }>> = {};
  /** The model's reply to `ai.generate`. */
  aiReply: (prompt: string) => string = () => "{\"intent\":\"clarify\",\"question\":\"What do you need?\"}";
  private readonly listeners: Array<{ table: string; callback: (event: { table: string }) => void }> = [];
  private nextRow = 1;
  private nextEvent = 1;

  readonly app = { name: "calendar" };
  readonly theme: Record<string, string> = {};
  readonly design = "default";

  generate(): void {}
  navigate(): void {}
  openApp(): void {}

  async integrations() {
    return [{ service: "google_calendar", account_label: "Work Google", account_email: OWNER, status: "active" }];
  }

  async capabilities() {
    return { version: 1 as const, integrations: true, ai: true };
  }

  readonly ai = {
    routes: async () => ({ routes: [], defaultRoute: null }),
    generate: async (input: { prompt: string }) => {
      this.prompts.push(input.prompt);
      return { text: this.aiReply(input.prompt) };
    },
  };

  /** The calendar app has no `files` permission; the real bridge refuses every call. */
  readonly files = new Proxy({}, {
    get: () => async () => {
      throw Object.assign(new Error("Not allowed"), { name: "BridgeFileError", code: "forbidden" });
    },
  });

  readonly db = {
    find: async (table: string, options: { where?: Record<string, unknown>; orderBy?: Record<string, "asc" | "desc">; limit?: number } = {}) => {
      const rows = (this.tables[table] ?? []).filter((row) => Object.entries(options.where ?? {}).every(([key, value]) => row[key] === value));
      return rows.slice(0, options.limit ?? rows.length).map((row) => structuredClone(row));
    },
    findOne: async (table: string, id: string) => this.tables[table]?.find((row) => row.id === id) ?? null,
    insert: async (table: string, data: Record<string, unknown>) => {
      const id = `row${this.nextRow++}`;
      (this.tables[table] ??= []).push({ ...structuredClone(data), id });
      this.emit(table);
      return { id };
    },
    update: async (table: string, id: string, data: Record<string, unknown>) => {
      const row = this.tables[table]?.find((item) => item.id === id);
      if (row) Object.assign(row, structuredClone(data));
      this.emit(table);
      return { ok: true as const };
    },
    delete: async (table: string, id: string) => {
      this.tables[table] = (this.tables[table] ?? []).filter((row) => row.id !== id);
      this.emit(table);
      return { ok: true as const };
    },
    onChange: (table: string, callback: (event: { table: string }) => void) => {
      const entry = { table, callback };
      this.listeners.push(entry);
      return () => {
        const index = this.listeners.indexOf(entry);
        if (index !== -1) this.listeners.splice(index, 1);
      };
    },
  };

  private emit(table: string): void {
    for (const listener of [...this.listeners]) if (listener.table === table) listener.callback({ table });
  }

  /** Inserts a row as another writer (the agent's tools) would, then notifies watchers. */
  async writeRow(table: string, row: Row): Promise<void> {
    (this.tables[table] ??= []).push(structuredClone(row));
    this.emit(table);
  }

  callsTo(action: string): ServiceCall[] {
    return this.calls.filter((call) => call.action === action);
  }

  async service(service: string, action: string, params: Record<string, unknown> = {}, label?: string) {
    // Round-trip through JSON like the real bridge.
    const sent = JSON.parse(JSON.stringify(params)) as Record<string, unknown>;
    this.calls.push({ service, action, params: sent, label });
    if (service !== "google_calendar") throw Object.assign(new Error("HTTP 404: no such service"), { status: 404 });
    const data = this.answer(action, sent);
    return { data: JSON.parse(JSON.stringify(data)) as unknown, service, action };
  }

  private answer(action: string, params: Record<string, unknown>): unknown {
    switch (action) {
      case "list_calendars":
        return CALENDAR_LIST;
      case "list_events": {
        const calendarId = String(params.calendarId);
        const items = (this.events[calendarId] ?? []).filter((event) => overlaps(event, String(params.timeMin), String(params.timeMax)));
        return { kind: "calendar#events", summary: calendarId, timeZone: "America/New_York", items };
      }
      case "free_busy": {
        const items = (params.items as unknown[]).map((item) => (typeof item === "string" ? item : String((item as { id?: unknown }).id)));
        const calendars: Record<string, unknown> = {};
        for (const address of items) calendars[address] = { busy: this.busy[address] ?? [] };
        return { kind: "calendar#freeBusy", timeMin: params.timeMin, timeMax: params.timeMax, calendars };
      }
      case "create_event_with_attendees":
        return this.create(params);
      default:
        throw Object.assign(new Error(`HTTP 400: unexpected ${action}`), { status: 400 });
    }
  }

  private create(params: Record<string, unknown>): GoogleEventJson {
    const calendarId = String(params.calendarId);
    const zone = typeof params.timeZone === "string" ? params.timeZone : undefined;
    const attendees = (params.attendees as Array<{ email: string; displayName?: string }> | undefined) ?? [];
    const event: GoogleEventJson = {
      id: `created${this.nextEvent++}`,
      status: "confirmed",
      summary: String(params.summary),
      start: { dateTime: String(params.start), ...(zone ? { timeZone: zone } : {}) },
      end: { dateTime: String(params.end), ...(zone ? { timeZone: zone } : {}) },
      organizer: { email: OWNER, self: true },
      attendees: [
        { email: OWNER, self: true, organizer: true, responseStatus: "accepted" },
        ...attendees.map((person) => ({ ...person, responseStatus: "needsAction" })),
      ],
    };
    (this.events[calendarId] ??= []).push(event);
    return event;
  }
}
