import { describe, it, expect } from "vitest";
import {
  SERVICE_REGISTRY,
  getService,
  listServices,
  getAction,
} from "../../packages/gateway/src/integrations/registry.js";

describe("Service Registry", () => {
  it("has 6 launch services", () => {
    expect(listServices()).toHaveLength(6);
    expect(Object.keys(SERVICE_REGISTRY)).toHaveLength(6);
  });

  it("returns service by id", () => {
    const gmail = getService("gmail");
    expect(gmail).toBeDefined();
    expect(gmail!.name).toBe("Gmail");
    expect(gmail!.category).toBe("google");
    expect(gmail!.pipedreamApp).toBe("gmail");
  });

  it("returns undefined for unknown service", () => {
    expect(getService("nonexistent")).toBeUndefined();
  });

  it("lists actions for gmail", () => {
    const gmail = getService("gmail");
    expect(gmail).toBeDefined();
    const actionIds = Object.keys(gmail!.actions);
    expect(actionIds).toContain("list_messages");
    expect(actionIds).toContain("send_email");
    expect(actionIds).toContain("get_message");
    expect(actionIds).toContain("search");
    expect(actionIds).toContain("list_labels");
  });

  it("getAction returns action by service and action id", () => {
    const action = getAction("gmail", "send_email");
    expect(action).toBeDefined();
    expect(action!.description).toBeDefined();
    expect(action!.params.to).toEqual({
      type: "string",
      required: true,
    });
    expect(action!.params.subject).toEqual({
      type: "string",
      required: true,
    });
    expect(action!.params.body).toEqual({
      type: "string",
      required: true,
    });
  });

  it("getAction returns undefined for unknown action", () => {
    expect(getAction("gmail", "nonexistent")).toBeUndefined();
  });

  it("getAction returns undefined for unknown service", () => {
    expect(getAction("nonexistent", "send_email")).toBeUndefined();
  });

  it("all services have required fields", () => {
    for (const service of listServices()) {
      expect(service.id).toBeTruthy();
      expect(service.name).toBeTruthy();
      expect(service.category).toBeTruthy();
      expect(service.pipedreamApp).toBeTruthy();
      expect(service.icon).toBeTruthy();
      expect(Object.keys(service.actions).length).toBeGreaterThan(0);
    }
  });

  it("contains all 6 expected services", () => {
    const ids = listServices().map((s) => s.id);
    expect(ids).toContain("gmail");
    expect(ids).toContain("google_calendar");
    expect(ids).toContain("google_drive");
    expect(ids).toContain("github");
    expect(ids).toContain("slack");
    expect(ids).toContain("discord");
  });
});
