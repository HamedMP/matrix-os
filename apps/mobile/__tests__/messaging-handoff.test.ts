import { messagingJourneyTarget } from "../lib/messaging-handoff";
describe("messaging navigation intent", () => {
  it("retains one bounded Chat reference through normal sign-in and journey routing", () => {
    expect(messagingJourneyTarget("chat_12345678")).toEqual({
      pathname: "/(drawer)",
      params: { chat: "chat_12345678" },
    });
    expect(messagingJourneyTarget("../../secrets")).toBe("/(drawer)");
    expect(messagingJourneyTarget(["chat_12345678", "chat_second"])).toBe(
      "/(drawer)",
    );
  });
});

import {
  messagingSignInTarget,
  messagingPrimaryComputer,
} from "../lib/messaging-handoff";
it("keeps the Chat through sign-in instead of bypassing the journey gate", () => {
  expect(messagingSignInTarget("chat_12345678")).toEqual({
    pathname: "/",
    params: { chat: "chat_12345678" },
  });
  expect(messagingSignInTarget(["chat_a", "chat_b"])).toBe("/(drawer)");
});
it("opens only the owner inventory primary customer computer", () => {
  const main = {
    runtimeSlot: "primary",
    kind: "customer",
    availability: "available",
  };
  expect(
    messagingPrimaryComputer({
      items: [
        { runtimeSlot: "pr-test", kind: "preview", availability: "available" },
        main,
      ],
    } as never),
  ).toBe(main);
  expect(() =>
    messagingPrimaryComputer({
      items: [{ ...main, availability: "unavailable" }],
    } as never),
  ).toThrow("Main Computer unavailable");
  expect(() =>
    messagingPrimaryComputer({
      items: [{ ...main, kind: "preview" }],
    } as never),
  ).toThrow();
});
