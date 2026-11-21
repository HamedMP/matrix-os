import { createSeenMessages } from "../components/chat/seen-messages";

describe("createSeenMessages", () => {
  it("remembers the messages it is told about", () => {
    const seen = createSeenMessages();
    expect(seen.has("msg_1")).toBe(false);

    seen.add("msg_1");

    expect(seen.has("msg_1")).toBe(true);
    expect(seen.has("msg_2")).toBe(false);
  });

  it("forgets the longest-ago one past its limit, so it cannot grow without end", () => {
    const seen = createSeenMessages(2);
    seen.add("msg_1");
    seen.add("msg_2");
    // Seen again: it is the most recent now.
    seen.add("msg_1");
    seen.add("msg_3");

    expect(seen.has("msg_2")).toBe(false);
    expect(seen.has("msg_1")).toBe(true);
    expect(seen.has("msg_3")).toBe(true);
  });
});
