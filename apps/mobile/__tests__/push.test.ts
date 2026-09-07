import { getRouteForNotification, type NotificationData } from "../lib/push";

describe("push notification routing", () => {
  it("routes message notifications to the mock drawer home", () => {
    const data: NotificationData = { category: "message" };
    expect(getRouteForNotification(data)).toBe("/(drawer)");
  });

  it("routes task notifications to the mock drawer home", () => {
    const data: NotificationData = { category: "task" };
    expect(getRouteForNotification(data)).toBe("/(drawer)");
  });

  it("routes cron notifications to the mock drawer home", () => {
    const data: NotificationData = { category: "cron" };
    expect(getRouteForNotification(data)).toBe("/(drawer)");
  });

  it("routes security notifications to the mock drawer home", () => {
    const data: NotificationData = { category: "security" };
    expect(getRouteForNotification(data)).toBe("/(drawer)");
  });

  it("keeps coding-agent attention notifications inside the mock shell", () => {
    const data: NotificationData = { category: "agent", threadId: "thread_mobile_attention" };
    expect(getRouteForNotification(data)).toBe("/(drawer)");
  });

  it("keeps invalid coding-agent notification targets inside the mock shell", () => {
    const data: NotificationData = { category: "agent", threadId: "../secret" };
    expect(getRouteForNotification(data)).toBe("/(drawer)");
  });

  it("defaults to the mock drawer home for unknown category", () => {
    const data: NotificationData = {};
    expect(getRouteForNotification(data)).toBe("/(drawer)");
  });

  it("defaults to the mock drawer home for undefined category", () => {
    const data: NotificationData = { category: undefined };
    expect(getRouteForNotification(data)).toBe("/(drawer)");
  });
});
