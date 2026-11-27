import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { showDesktopNotification } from "../../desktop/src/main/notifications";

class FakeNotification extends EventEmitter {
  static supported = true;
  static instances: FakeNotification[] = [];
  static isSupported() { return FakeNotification.supported; }
  shown = false;
  constructor(readonly options: { title: string; body: string; silent?: boolean }) {
    super();
    FakeNotification.instances.push(this);
  }
  show() { this.shown = true; }
}

afterEach(() => {
  FakeNotification.supported = true;
  FakeNotification.instances = [];
  vi.restoreAllMocks();
});

describe("desktop notifications", () => {
  it("shows the notification and routes clicks", () => {
    const onClick = vi.fn();
    showDesktopNotification(FakeNotification, { title: "t", body: "b" }, { onClick });
    const [notification] = FakeNotification.instances;
    expect(notification?.shown).toBe(true);
    expect(notification?.options).toEqual({ title: "t", body: "b", silent: false });
    notification?.emit("click");
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  // Electron 42+ macOS UNNotification emits `failed` for unsigned builds or
  // denied permission. The failure must be logged without its message body.
  it("logs a failed delivery without leaking the notification content", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    showDesktopNotification(FakeNotification, { title: "private title", body: "private body" });
    FakeNotification.instances[0]?.emit("failed", {}, "UNErrorDomain code 1: private body");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private");
  });

  it("does nothing when notifications are unsupported", () => {
    FakeNotification.supported = false;
    showDesktopNotification(FakeNotification, { title: "t", body: "b" });
    expect(FakeNotification.instances).toHaveLength(0);
  });
});
