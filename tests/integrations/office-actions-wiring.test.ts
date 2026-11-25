import { describe, expect, it } from "vitest";
import { appIntegrationReplyBytes } from "../../packages/contracts/src/app-capabilities.js";
import { INTEGRATION_PRESENTATION } from "../../packages/contracts/src/integration-marketplace.js";
import { MANAGED_WRITE_ACTIONS } from "../../packages/kernel/src/hooks.js";
import { getService, listServices } from "../../packages/gateway/src/integrations/registry.js";
import { GOOGLE_SERVICES } from "../../packages/gateway/src/integrations/google.js";
import { OFFICE_READ_ACTIONS, OFFICE_WRITE_ACTIONS, officeReadActions } from "../../packages/gateway/src/integrations/office-actions.js";
import { GOOGLE_CALENDAR_SCHEDULING_READ_ACTIONS, GOOGLE_CALENDAR_SCHEDULING_WRITE_ACTIONS } from "../../packages/gateway/src/integrations/google-calendar-scheduling.js";

const OFFICE_WRITES = [
  "google_calendar/create_event_with_attendees", "google_calendar/update_event_details",
  "google_calendar/delete_event", "google_calendar/respond_event",
];
const OFFICE_READS = ["google_calendar/free_busy"];
const keys = (map: Record<string, Record<string, unknown>>) =>
  Object.entries(map).flatMap(([service, actions]) => Object.keys(actions).map(action => `${service}/${action}`));
const MIB = 1024 * 1024;

describe("office calendar action wiring", () => {
  it("collects exactly the 4 reviewed writes and 1 reviewed read", () => {
    expect(keys(OFFICE_WRITE_ACTIONS).sort()).toEqual([...OFFICE_WRITES].sort());
    expect(keys(OFFICE_READ_ACTIONS).sort()).toEqual([...OFFICE_READS].sort());
  });

  it("collects the action objects exactly as the owning module defines them", () => {
    for (const [service, actions] of Object.entries(GOOGLE_CALENDAR_SCHEDULING_WRITE_ACTIONS)) {
      for (const [id, action] of Object.entries(actions)) expect(OFFICE_WRITE_ACTIONS[service]?.[id]).toBe(action);
    }
    expect(officeReadActions("google_calendar")).toEqual(GOOGLE_CALENDAR_SCHEDULING_READ_ACTIONS);
    expect(officeReadActions("slack")).toEqual({});
  });

  it("publishes every office action on its service in the live registry with validation", () => {
    for (const [map, risk] of [[OFFICE_WRITE_ACTIONS, "write"], [OFFICE_READ_ACTIONS, "read"]] as const) {
      for (const [service, actions] of Object.entries(map)) {
        for (const [id, action] of Object.entries(actions)) {
          expect(getService(service)?.actions[id], `${service}/${id}`).toBe(action);
          expect(action.risk, `${service}/${id}`).toBe(risk);
          expect(action.paramsSchema, `${service}/${id}`).toBeDefined();
          expect(action.directApi, `${service}/${id}`).toBeDefined();
          for (const key of Object.keys(action.params)) expect(typeof action.params[key]!.type).toBe("string");
        }
      }
    }
  });

  it("never shadows an action that Google Calendar already defined", () => {
    const before = GOOGLE_SERVICES.google_calendar!.actions;
    for (const key of [...OFFICE_WRITES, ...OFFICE_READS]) {
      const action = key.split("/")[1]!;
      expect(Object.hasOwn(before, action), key).toBe(false);
    }
    expect(getService("google_calendar")?.actions.list_events).toBe(before.list_events);
  });

  it("adds nothing to mail or to Outlook calendar", () => {
    expect(Object.keys(OFFICE_WRITE_ACTIONS)).toEqual(["google_calendar"]);
    expect(Object.keys(OFFICE_READ_ACTIONS)).toEqual(["google_calendar"]);
    const outlook = getService("microsoft_outlook_calendar")!.actions;
    for (const action of ["create_event_with_attendees", "update_event", "delete_event", "respond_event", "get_schedule"]) {
      expect(Object.hasOwn(outlook, action), action).toBe(false);
    }
    expect(INTEGRATION_PRESENTATION.microsoft_outlook_calendar!.description).toBe("Read calendars and events");
  });

  it("requires owner approval for every office write and none for office reads", () => {
    for (const key of OFFICE_WRITES) expect(MANAGED_WRITE_ACTIONS.has(key), key).toBe(true);
    for (const key of OFFICE_READS) expect(MANAGED_WRITE_ACTIONS.has(key), key).toBe(false);
  });

  it("registers no destructive office action", () => {
    for (const service of listServices()) {
      expect(Object.values(service.actions).every(action => action.risk !== "destructive"), service.id).toBe(true);
    }
  });

  it("raises the reply cap for a month of Google Calendar events only", () => {
    expect(appIntegrationReplyBytes("google_calendar", "list_events")).toBe(MIB);
    expect(appIntegrationReplyBytes("google_calendar", "free_busy")).toBe(256 * 1024);
    expect(appIntegrationReplyBytes("microsoft_outlook_calendar", "list_events")).toBe(256 * 1024);
    expect(appIntegrationReplyBytes("gmail", "get_attachment")).toBe(1.5 * MIB);
  });
});
