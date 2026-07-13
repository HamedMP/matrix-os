import { getRouteForNotification, type NotificationData } from "../lib/push";

describe("push notification routing", () => {
  it("routes message notifications to chat tab", () => {
    const data: NotificationData = { category: "message" };
    expect(getRouteForNotification(data)).toBe("/(tabs)/chat");
  });

  it("routes task notifications to mission control", () => {
    const data: NotificationData = { category: "task" };
    expect(getRouteForNotification(data)).toBe("/(tabs)/mission-control");
  });

  it("routes cron notifications to mission control", () => {
    const data: NotificationData = { category: "cron" };
    expect(getRouteForNotification(data)).toBe("/(tabs)/mission-control");
  });

  it("routes security notifications to settings", () => {
    const data: NotificationData = { category: "security" };
    expect(getRouteForNotification(data)).toBe("/(tabs)/settings");
  });

  it("routes coding-agent attention notifications to the bounded thread route", () => {
    const data: NotificationData = { category: "agent", threadId: "thread_mobile_attention" };
    expect(getRouteForNotification(data)).toBe("/agents/thread_mobile_attention");
  });

  it("defaults coding-agent notifications with invalid thread ids to the agent workspace", () => {
    const data: NotificationData = { category: "agent", threadId: "../secret" };
    expect(getRouteForNotification(data)).toBe("/agents");
  });

  it("defaults to chat for unknown category", () => {
    const data: NotificationData = {};
    expect(getRouteForNotification(data)).toBe("/(tabs)/chat");
  });

  it("defaults to chat for undefined category", () => {
    const data: NotificationData = { category: undefined };
    expect(getRouteForNotification(data)).toBe("/(tabs)/chat");
  });
});
