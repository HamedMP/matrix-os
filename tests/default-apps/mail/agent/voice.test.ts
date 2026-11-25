import { describe, expect, it, vi } from "vitest";
import type { MailFolder, MailMessage, MailThread, ThreadSummary } from "../../../../home/apps/_shared/office-accounts/types/mail";
import { deriveVoiceProfile, ownText, voiceContext } from "../../../../home/apps/mail/src/agent/voice-derive";
import { VOICE_TABLE, createVoiceProfileCache } from "../../../../home/apps/mail/src/agent/voice-cache";
import { loadVoiceProfile } from "../../../../home/apps/mail/src/agent/voice";
import { FakeDb } from "../model/fake-db";
import { FakeProvider } from "../model/fake-provider";
import { GMAIL, GMAIL_FOLDERS, message, summary } from "../model/fixtures";

function sent(id: string, bodyText: string, to = "alice@example.com"): MailMessage {
  return message(id, { from: { name: "Me", address: GMAIL.address }, to: [{ address: to }], bodyText });
}

const CASUAL = [
  "Hey Alice,\n\nSounds good, I'll bring the slides. Can't wait!\n\nCheers,\nSam\n\nOn Mon, Nov 9, 2026, Alice <alice@example.com> wrote:\n> Are we still on for Thursday?",
  "Hey Alice,\n\nYep, that's fine by me. Let's do 3pm.\n\nCheers,\nSam",
  "hey Alice,\n\nGot it, thanks! I'll send it over tonight.\n\nCheers,\nSam\n-- \nSam Example | Example Co",
];

const FORMAL = [
  "Dear Mr. Smith,\n\nThank you for your message. Please find the revised agreement attached for your review. I would appreciate your comments by Friday.\n\nKind regards,\nSamuel Example",
  "Dear Mr. Smith,\n\nI am writing to confirm our meeting on the 12th. Please let me know whether the proposed agenda is acceptable.\n\nKind regards,\nSamuel Example",
];

describe("ownText", () => {
  it("drops quoted replies, forwarded parts and the signature", () => {
    expect(ownText(CASUAL[0])).toBe("Hey Alice,\n\nSounds good, I'll bring the slides. Can't wait!\n\nCheers,\nSam");
    expect(ownText(CASUAL[2])).not.toContain("Example Co");
    expect(ownText("Short note\n\n---------- Forwarded message ----------\nFrom: x")).toBe("Short note");
  });
});

describe("deriveVoiceProfile", () => {
  it("learns greeting, sign-off, name, casual tone, length and language", () => {
    const profile = deriveVoiceProfile(CASUAL.map((body, i) => sent(`m${i}`, body)), { recipient: "alice@example.com", now: 0 });
    expect(profile.sampleCount).toBe(3);
    expect(profile.greeting).toBe("Hey {name},");
    expect(profile.signOff).toBe("Cheers,");
    expect(profile.signatureName).toBe("Sam");
    expect(profile.formality).toBe("casual");
    expect(profile.length).toBe("short");
    expect(profile.typicalWords).toBeGreaterThan(5);
    expect(profile.typicalWords).toBeLessThan(30);
    expect(profile.language).toBe("en");
    expect(profile.excerpts.length).toBeGreaterThan(0);
    expect(profile.excerpts.join(" ")).not.toContain("Are we still on");
  });

  it("recognises a formal voice", () => {
    const profile = deriveVoiceProfile(FORMAL.map((body, i) => sent(`f${i}`, body, "smith@corp.example")), { recipient: "smith@corp.example", now: 0 });
    expect(profile.greeting).toBe("Dear {name},");
    expect(profile.signOff).toBe("Kind regards,");
    expect(profile.formality).toBe("formal");
  });

  it("detects German", () => {
    const body = "Hallo Jan,\n\nich habe die Unterlagen gelesen und das passt so. Wir sehen uns am Montag und dann besprechen wir die Details.\n\nViele Grüße\nSam";
    const profile = deriveVoiceProfile([sent("d1", body), sent("d2", body)], { recipient: null, now: 0 });
    expect(profile.language).toBe("de");
    expect(profile.signOff).toBe("Viele Grüße");
  });

  it("returns a neutral default with no samples", () => {
    const profile = deriveVoiceProfile([], { recipient: null, now: 0 });
    expect(profile.sampleCount).toBe(0);
    expect(profile.greeting).toBeNull();
    expect(profile.formality).toBe("neutral");
  });

  it("ignores messages the owner did not write", () => {
    const foreign = message("x", { from: { address: "alice@example.com" }, bodyText: "Dear Sam,\n\nRegards,\nAlice" });
    const profile = deriveVoiceProfile([foreign], { recipient: null, now: 0, ownerAddress: GMAIL.address });
    expect(profile.sampleCount).toBe(0);
  });

  it("voiceContext describes the profile as trusted prose without excerpts wider than the cap", () => {
    const profile = deriveVoiceProfile(CASUAL.map((body, i) => sent(`m${i}`, body)), { recipient: "alice@example.com", now: 0 });
    const text = voiceContext(profile);
    expect(text).toContain("Hey {name},");
    expect(text).toContain("casual");
    expect(text.length).toBeLessThan(2500);
  });
});

describe("voice profile cache", () => {
  it("stores one row per account and recipient and reads it back", async () => {
    const db = new FakeDb({ [VOICE_TABLE]: "profile_key" });
    const cache = createVoiceProfileCache(db, { now: () => 1000 });
    const profile = deriveVoiceProfile(CASUAL.map((body, i) => sent(`m${i}`, body)), { recipient: "alice@example.com", now: 1000 });
    await cache.set(GMAIL.id, "Alice@Example.com", profile);
    await cache.set(GMAIL.id, "alice@example.com", profile);
    expect(db.tables[VOICE_TABLE]).toHaveLength(1);
    const fresh = createVoiceProfileCache(db, { now: () => 2000 });
    expect((await fresh.get(GMAIL.id, "alice@example.com"))?.greeting).toBe("Hey {name},");
  });

  it("treats an expired or malformed row as missing", async () => {
    const db = new FakeDb({ [VOICE_TABLE]: "profile_key" });
    const profile = deriveVoiceProfile([], { recipient: null, now: 0 });
    await createVoiceProfileCache(db, { now: () => 0 }).set(GMAIL.id, null, profile);
    expect(await createVoiceProfileCache(db, { now: () => 8 * 24 * 3600 * 1000 }).get(GMAIL.id, null)).toBeNull();
    db.tables[VOICE_TABLE][0].profile = { version: 99 };
    expect(await createVoiceProfileCache(db, { now: () => 1 }).get(GMAIL.id, null)).toBeNull();
  });

  it("keeps working in memory when the database fails", async () => {
    const db = new FakeDb({ [VOICE_TABLE]: "profile_key" });
    const log = vi.fn();
    const cache = createVoiceProfileCache(db, { now: () => 1, logger: log });
    db.failNext = "find";
    const profile = deriveVoiceProfile([], { recipient: null, now: 1 });
    await cache.set(GMAIL.id, "bob@example.com", profile);
    expect(await cache.get(GMAIL.id, "bob@example.com")).not.toBeNull();
    expect(log).toHaveBeenCalled();
  });
});

describe("loadVoiceProfile", () => {
  function provider(): FakeProvider {
    const p = new FakeProvider(GMAIL_FOLDERS as MailFolder[]);
    p.lists.SENT = [summary("s1", { folderIds: ["SENT"] }), summary("s2", { folderIds: ["SENT"] })] as ThreadSummary[];
    p.threads.s1 = { id: "s1", accountId: GMAIL.id, subject: "a", folderIds: ["SENT"], messages: [sent("o1", FORMAL[0], "x@y.example")] } as MailThread;
    p.threads.s2 = { id: "s2", accountId: GMAIL.id, subject: "b", folderIds: ["SENT"], messages: [sent("o2", FORMAL[1], "x@y.example")] } as MailThread;
    return p;
  }

  it("uses the recipient's samples and caches the profile", async () => {
    const p = provider();
    const listSentTo = vi.spyOn(p, "listSentTo").mockResolvedValue(CASUAL.map((body, i) => sent(`m${i}`, body)) as never[]);
    const db = new FakeDb({ [VOICE_TABLE]: "profile_key" });
    const cache = createVoiceProfileCache(db, { now: () => 5 });
    const first = await loadVoiceProfile({ account: GMAIL, provider: p, recipient: "alice@example.com", folders: GMAIL_FOLDERS, cache, now: () => 5 });
    expect(first.greeting).toBe("Hey {name},");
    expect(listSentTo).toHaveBeenCalledWith("alice@example.com", 10);
    await loadVoiceProfile({ account: GMAIL, provider: p, recipient: "alice@example.com", folders: GMAIL_FOLDERS, cache, now: () => 5 });
    expect(listSentTo).toHaveBeenCalledTimes(1);
  });

  it("falls back to the overall sample from the sent folder when the recipient has too few", async () => {
    const p = provider();
    vi.spyOn(p, "listSentTo").mockResolvedValue([]);
    const cache = createVoiceProfileCache(undefined, { now: () => 5 });
    const profile = await loadVoiceProfile({ account: GMAIL, provider: p, recipient: "new@example.com", folders: GMAIL_FOLDERS, cache, now: () => 5 });
    expect(profile.formality).toBe("formal");
    expect(profile.recipient).toBeNull();
    expect(p.calls.listThreads[0]).toMatchObject({ folderId: "SENT" });
  });

  it("returns the neutral default when the mailbox cannot be read", async () => {
    const p = provider();
    vi.spyOn(p, "listSentTo").mockRejectedValue(new Error("down"));
    p.onListThreads = async () => {
      throw new Error("down");
    };
    const cache = createVoiceProfileCache(undefined, { now: () => 5 });
    const profile = await loadVoiceProfile({ account: GMAIL, provider: p, recipient: "a@b.example", folders: GMAIL_FOLDERS, cache, now: () => 5, logger: () => {} });
    expect(profile.sampleCount).toBe(0);
  });
});
