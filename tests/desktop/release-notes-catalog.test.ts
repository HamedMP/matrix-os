import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_RELEASE_NOTES_HIGHLIGHTS,
  ReleaseNotesSchema,
  compareReleaseVersions,
} from "../../desktop/src/shared/release-notes";
import {
  BUNDLED_RELEASE_NOTES,
  buildReleaseNotesCatalog,
  releaseNotesForVersion,
  technicalReleaseNotesUrl,
  whatsNewEntries,
} from "../../desktop/src/renderer/src/features/updates/release-notes-catalog";
import { resolveHighlightArt } from "../../desktop/src/renderer/src/features/updates/highlight-art";

const valid = {
  version: "0.1.24",
  channel: "canary",
  date: "2026-11-16",
  title: "Your agents, at a glance",
  summary: "See which coding agents are running.",
  highlights: [{ title: "Agent status everywhere", body: "Agents report status.", surfaces: ["web-desktop"] }],
  items: [{ kind: "new", text: "Set up GitHub from Settings." }],
};

describe("release notes schema", () => {
  it("accepts the committed 0.1.29 notes and defaults the locale to English", () => {
    const committed = JSON.parse(readFileSync(join(process.cwd(), "release-notes/0.1.29.json"), "utf8"));
    const parsed = ReleaseNotesSchema.parse(committed);
    expect(parsed.title).toBe("Your agents, at a glance");
    expect(ReleaseNotesSchema.parse(valid).locale).toBe("en");
  });

  it("rejects unknown fields, unknown surfaces and unbounded content", () => {
    expect(ReleaseNotesSchema.safeParse({ ...valid, extra: true }).success).toBe(false);
    expect(
      ReleaseNotesSchema.safeParse({
        ...valid,
        highlights: [{ title: "x", body: "y", surfaces: ["electron"] }],
      }).success,
    ).toBe(false);
    expect(ReleaseNotesSchema.safeParse({ ...valid, title: "x".repeat(500) }).success).toBe(false);
    expect(
      ReleaseNotesSchema.safeParse({
        ...valid,
        highlights: Array.from({ length: MAX_RELEASE_NOTES_HIGHLIGHTS + 1 }, () => valid.highlights[0]),
      }).success,
    ).toBe(false);
  });

  it("only accepts bundled media file names, never URLs or paths", () => {
    const withMedia = (media: string) =>
      ReleaseNotesSchema.safeParse({ ...valid, highlights: [{ title: "x", body: "y", media }] }).success;
    expect(withMedia("agent-status.webp")).toBe(true);
    expect(withMedia("https://tracker.example/pixel.png")).toBe(false);
    expect(withMedia("../secret.png")).toBe(false);
  });

  it("rejects uppercase media names the renderer would not bundle", () => {
    const withMedia = (media: string) =>
      ReleaseNotesSchema.safeParse({ ...valid, highlights: [{ title: "x", body: "y", media }] }).success;
    expect(withMedia("status.png")).toBe(true);
    expect(withMedia("status.PNG")).toBe(false);
    expect(withMedia("Status.webp")).toBe(false);
  });

  it("orders versions numerically, with prereleases before their release", () => {
    expect(compareReleaseVersions("0.1.10", "0.1.9")).toBeGreaterThan(0);
    expect(compareReleaseVersions("0.2.0-canary.1", "0.2.0")).toBeLessThan(0);
    expect(compareReleaseVersions("1.0.0", "1.0.0")).toBe(0);
  });
});

describe("release notes catalog", () => {
  it("lists bundled releases newest first and skips invalid files with a warning", () => {
    const warn = vi.fn();
    const catalog = buildReleaseNotesCatalog(
      {
        "/release-notes/0.1.9.json": { ...valid, version: "0.1.9" },
        "/release-notes/0.1.10.json": { ...valid, version: "0.1.10" },
        "/release-notes/broken.json": { version: "nope" },
      },
      warn,
    );
    expect(catalog.map((entry) => entry.version)).toEqual(["0.1.10", "0.1.9"]);
    expect(warn).toHaveBeenCalledWith("[whats-new] skipped invalid release notes:", "broken.json");
  });

  it("keeps one entry per version", () => {
    const warn = vi.fn();
    const catalog = buildReleaseNotesCatalog(
      { "/a/0.1.9.json": { ...valid, version: "0.1.9" }, "/b/0.1.9.json": { ...valid, version: "0.1.9" } },
      warn,
    );
    expect(catalog).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith("[whats-new] skipped duplicate release notes:", "0.1.9.json");
  });

  it("bundles only stable release-history rows into the renderer", () => {
    expect(BUNDLED_RELEASE_NOTES.some((entry) => entry.version === "0.1.24")).toBe(true);
    expect(BUNDLED_RELEASE_NOTES.every((entry) => entry.channel === "stable")).toBe(true);
    expect(BUNDLED_RELEASE_NOTES.some((entry) => entry.version === "0.1.24-canary")).toBe(false);
  });

  it("falls back to the update's markdown notes when its version has no structured notes", () => {
    const catalog = buildReleaseNotesCatalog({ "/x/0.1.24.json": { ...valid, channel: "stable" } }, vi.fn());
    const entries = whatsNewEntries(catalog, {
      version: "0.1.25",
      releaseDate: "2026-11-23T09:00:00.000Z",
      notes: "## Fixed\n\n- Faster",
    });
    expect(entries.map((entry) => [entry.version, entry.kind])).toEqual([
      ["0.1.25", "markdown"],
      ["0.1.24", "structured"],
    ]);
    expect(whatsNewEntries(catalog, { version: "0.1.24", notes: "ignored" })).toHaveLength(1);
    expect(whatsNewEntries(catalog, null)).toHaveLength(1);
  });

  // Canary builds are versioned <base>-canary.<build stamp> on an old base
  // (0.1.24-canary.* ships after stable 0.1.29), and the stamp is unknown when
  // the notes are written.
  const canaryCatalog = () =>
    buildReleaseNotesCatalog(
      {
        "/x/0.1.24.json": { ...valid, version: "0.1.24", channel: "stable", date: "2026-11-11T17:28:15Z" },
        "/x/0.1.29.json": { ...valid, version: "0.1.29", channel: "stable", date: "2026-11-16T20:23:13Z" },
        "/x/0.1.24-canary.json": { ...valid, version: "0.1.24-canary", date: "2026-11-16T21:29:26Z" },
      },
      vi.fn(),
    );

  it("shows the canary channel entry for any canary build of that base", () => {
    const catalog = canaryCatalog();
    expect(releaseNotesForVersion(catalog, "0.1.24-canary.20261117090000")?.version).toBe("0.1.24-canary");
    expect(releaseNotesForVersion(catalog, "0.1.24")?.version).toBe("0.1.24");
    expect(releaseNotesForVersion(catalog, "0.1.24-canaryx.1")).toBeNull();
    expect(releaseNotesForVersion(catalog, "0.1.25-canary.1")).toBeNull();

    const entries = whatsNewEntries(catalog, {
      version: "0.1.24-canary.20261117090000",
      notes: "## Canary\n\n- markdown body",
    });
    expect(entries.map((entry) => [entry.version, entry.kind])).toEqual([
      ["0.1.24-canary.20261117090000", "structured"],
      ["0.1.29", "structured"],
      ["0.1.24", "structured"],
    ]);
  });

  it("prefers an exact build file over the channel entry", () => {
    const catalog = buildReleaseNotesCatalog(
      {
        "/x/0.1.24-canary.json": { ...valid, version: "0.1.24-canary", title: "Channel" },
        "/x/0.1.24-canary.5.json": { ...valid, version: "0.1.24-canary.5", title: "Exact" },
      },
      vi.fn(),
    );
    expect(releaseNotesForVersion(catalog, "0.1.24-canary.5")?.title).toBe("Exact");
  });

  it("hides entries from less stable channels unless the build is on that channel", () => {
    const catalog = canaryCatalog();
    const versions = (entries: ReturnType<typeof whatsNewEntries>) => entries.map((entry) => entry.version);
    expect(versions(whatsNewEntries(catalog, null, "stable"))).toEqual(["0.1.29", "0.1.24"]);
    expect(versions(whatsNewEntries(catalog, null, "beta"))).toEqual(["0.1.29", "0.1.24"]);
    expect(versions(whatsNewEntries(catalog, null, "canary"))).toEqual(["0.1.24-canary", "0.1.29", "0.1.24"]);
    expect(versions(whatsNewEntries(catalog, null, "dev"))).toEqual(["0.1.24-canary", "0.1.29", "0.1.24"]);
    // Without a known build channel, the installed version decides it.
    expect(versions(whatsNewEntries(catalog, { version: "0.1.29", notes: "" }))).toEqual(["0.1.29", "0.1.24"]);
    expect(versions(whatsNewEntries(catalog, { version: "0.1.24-canary.7", notes: "" }))).toEqual([
      "0.1.24-canary.7",
      "0.1.29",
      "0.1.24",
    ]);
    // Unknown channel and no installed release: show everything.
    expect(versions(whatsNewEntries(catalog, null))).toEqual(["0.1.24-canary", "0.1.29", "0.1.24"]);
  });

  it("always keeps the entry for the installed release", () => {
    const catalog = canaryCatalog();
    const entries = whatsNewEntries(catalog, { version: "0.1.24-canary.7", notes: "" }, "stable");
    expect(entries[0]).toMatchObject({ version: "0.1.24-canary.7", kind: "structured" });
  });

  it("orders history by release date, so a newer canary on an older base comes first", () => {
    expect(canaryCatalog().map((entry) => entry.version)).toEqual(["0.1.24-canary", "0.1.29", "0.1.24"]);
  });
});

describe("technical release notes link", () => {
  it("links an exact release to its immutable tag", () => {
    expect(technicalReleaseNotesUrl("0.1.24")).toBe("https://github.com/HamedMP/matrix-os/releases/tag/desktop-v0.1.24");
    expect(technicalReleaseNotesUrl("0.1.24-canary.20261116212926")).toBe(
      "https://github.com/HamedMP/matrix-os/releases/tag/desktop-v0.1.24-canary.20261116212926",
    );
  });

  it("links a channel entry without a build stamp to that channel's releases", () => {
    expect(technicalReleaseNotesUrl("0.1.24-canary")).toBe(
      "https://github.com/HamedMP/matrix-os/releases?q=desktop-v0.1.24-canary&expanded=true",
    );
  });
});

describe("highlight art", () => {
  it("parses the built-in illustrations and tones and rejects unknown ones", () => {
    const withArt = (extra: Record<string, unknown>) =>
      ReleaseNotesSchema.safeParse({ ...valid, highlights: [{ title: "x", body: "y", ...extra }] });
    const parsed = withArt({ art: "terminal", tone: "ink" });
    expect(parsed.success && parsed.data.highlights[0]).toMatchObject({ art: "terminal", tone: "ink" });
    expect(withArt({ art: "rocket" }).success).toBe(false);
    expect(withArt({ tone: "purple" }).success).toBe(false);
  });

  it("keeps explicit choices and falls back by position", () => {
    expect(resolveHighlightArt({ title: "x", body: "y", art: "shield", tone: "sand" }, 0)).toEqual({
      art: "shield",
      tone: "sand",
    });
    const fallback = [0, 1, 2, 3, 4].map((index) => resolveHighlightArt({ title: "x", body: "y" }, index));
    expect(fallback).toEqual([0, 1, 2, 3, 4].map((index) => resolveHighlightArt({ title: "z", body: "w" }, index)));
    expect(fallback.map((entry) => entry.tone)).toEqual(["lime", "teal", "sand", "ink", "lime"]);
    expect(new Set(fallback.map((entry) => entry.art)).size).toBe(5);
  });
});
