import { describe, expect, it } from "vitest";
import {
  MAX_RECIPIENT_INPUT_CHARS,
  mergeRecipients,
  parseRecipients,
  pendingRecipientText,
  removeRecipient,
  splitRecipientText,
} from "../../../../home/apps/mail/src/compose/recipients";
import { collectKnownAddresses, suggestAddresses } from "../../../../home/apps/mail/src/compose/address-book";
import { MAX_DRAFT_RECIPIENTS } from "../../../../home/apps/_shared/office-accounts/types/mail";
import { summary } from "../model/fixtures";

describe("splitRecipientText", () => {
  it("splits on commas, semicolons and line breaks outside quotes and angle brackets", () => {
    expect(splitRecipientText('"Doe, Jane" <jane@example.com>, bob@example.com; carol@example.com\ndan@example.com')).toEqual([
      '"Doe, Jane" <jane@example.com>',
      "bob@example.com",
      "carol@example.com",
      "dan@example.com",
    ]);
  });

  it("drops empty parts and caps very long input", () => {
    expect(splitRecipientText(" , ;; ")).toEqual([]);
    const huge = "a@example.com,".repeat(MAX_RECIPIENT_INPUT_CHARS);
    expect(splitRecipientText(huge).join(",").length).toBeLessThanOrEqual(MAX_RECIPIENT_INPUT_CHARS);
  });
});

describe("parseRecipients", () => {
  it("keeps valid addresses with their names and lower-cases them", () => {
    const parsed = parseRecipients('Jane Doe <Jane@Example.com>, bob@example.com');
    expect(parsed.valid).toEqual([{ name: "Jane Doe", address: "jane@example.com" }, { address: "bob@example.com" }]);
    expect(parsed.invalid).toEqual([]);
  });

  it("reports what it cannot read instead of dropping it", () => {
    const parsed = parseRecipients("alice@example.com, not an address, bob@, <evil@x>, eve@example.com");
    expect(parsed.valid.map((entry) => entry.address)).toEqual(["alice@example.com", "eve@example.com"]);
    expect(parsed.invalid).toEqual(["not an address", "bob@", "<evil@x>"]);
  });

  it("rejects header injection attempts", () => {
    const parsed = parseRecipients("a@example.com\r\nBcc: victim@example.com");
    expect(parsed.valid.map((entry) => entry.address)).toEqual(["a@example.com"]);
    expect(parsed.invalid).toEqual(["Bcc: victim@example.com"]);
  });
});

describe("pendingRecipientText", () => {
  it("commits complete addresses typed before a separator and keeps the rest", () => {
    expect(pendingRecipientText("alice@example.com, bo")).toEqual({ commit: "alice@example.com", rest: "bo" });
    expect(pendingRecipientText("alice@example.com;")).toEqual({ commit: "alice@example.com", rest: "" });
    expect(pendingRecipientText("alice")).toEqual({ commit: "", rest: "alice" });
  });
});

describe("mergeRecipients / removeRecipient", () => {
  it("adds without duplicates, keeping the first name seen", () => {
    const merged = mergeRecipients([{ address: "a@example.com" }], [{ name: "A", address: "A@example.com" }, { address: "b@example.com" }]);
    expect(merged).toEqual([{ address: "a@example.com" }, { address: "b@example.com" }]);
    expect(removeRecipient(merged, "A@EXAMPLE.com")).toEqual([{ address: "b@example.com" }]);
  });

  it("never grows past the provider's recipient limit", () => {
    const many = Array.from({ length: MAX_DRAFT_RECIPIENTS + 20 }, (_, i) => ({ address: `p${i}@example.com` }));
    expect(mergeRecipients([], many)).toHaveLength(MAX_DRAFT_RECIPIENTS);
  });
});

describe("address book", () => {
  const threads = {
    a: summary("a", { lastMessageAt: "2026-11-01T10:00:00Z", participants: [{ name: "Alice Smith", address: "alice@example.com" }, { address: "me@example.com" }] }),
    b: summary("b", { lastMessageAt: "2026-11-05T10:00:00Z", participants: [{ name: "Bob Jones", address: "bob@corp.example" }, { address: "ALICE@example.com" }] }),
    c: summary("c", { lastMessageAt: "2026-11-03T10:00:00Z", participants: [{ address: "not-valid" }, { name: "Albert", address: "albert@example.com" }] }),
  };

  it("collects every valid address seen in the cache, newest first, without the owner's own", () => {
    const book = collectKnownAddresses(threads, ["me@example.com"]);
    expect(book.map((entry) => entry.address)).toEqual(["bob@corp.example", "alice@example.com", "albert@example.com"]);
    expect(book.find((entry) => entry.address === "alice@example.com")?.name).toBe("Alice Smith");
  });

  it("suggests by address or name prefix and skips recipients already added", () => {
    const book = collectKnownAddresses(threads, ["me@example.com"]);
    expect(suggestAddresses(book, "al", []).map((entry) => entry.address)).toEqual(["alice@example.com", "albert@example.com"]);
    expect(suggestAddresses(book, "jon", []).map((entry) => entry.address)).toEqual(["bob@corp.example"]);
    expect(suggestAddresses(book, "corp", []).map((entry) => entry.address)).toEqual(["bob@corp.example"]);
    expect(suggestAddresses(book, "al", [{ address: "alice@example.com" }]).map((entry) => entry.address)).toEqual(["albert@example.com"]);
    expect(suggestAddresses(book, "", [])).toEqual([]);
    expect(suggestAddresses(book, "a", [], 1)).toHaveLength(1);
  });
});
