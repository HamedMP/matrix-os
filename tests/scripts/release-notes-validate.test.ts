import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateReleaseNotesDirectory } from "../../scripts/release-notes/validate.mjs";

const root = process.cwd();

const notes = (version: string, extra: Record<string, unknown> = {}) => ({
  version,
  channel: "canary",
  date: "2026-11-16",
  title: "Title",
  summary: "Summary.",
  highlights: [],
  items: [{ kind: "fixed", text: "A fix." }],
  ...extra,
});

describe("release notes validator", () => {
  const dirs: string[] = [];
  const tempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "release-notes-"));
    dirs.push(dir);
    return dir;
  };

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("accepts every committed release-notes file", async () => {
    const result = await validateReleaseNotesDirectory(join(root, "release-notes"));
    expect(result.errors).toEqual([]);
    expect(result.files).toContain("0.1.29.json");
  });

  it("reports malformed JSON, schema failures, name mismatches and missing media", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "0.1.1.json"), "{ not json");
    writeFileSync(join(dir, "0.1.2.json"), JSON.stringify({ ...notes("0.1.2"), channel: "nightly" }));
    writeFileSync(join(dir, "0.1.3.json"), JSON.stringify(notes("0.1.4")));
    writeFileSync(
      join(dir, "0.1.5.json"),
      JSON.stringify(notes("0.1.5", { highlights: [{ title: "x", body: "y", media: "missing.webp" }] })),
    );

    const { errors } = await validateReleaseNotesDirectory(dir);
    expect(errors).toEqual([
      "0.1.1.json: not valid JSON",
      expect.stringMatching(/^0\.1\.2\.json: channel: /),
      "0.1.3.json: version 0.1.4 does not match the file name",
      "0.1.5.json: highlights[0].media missing.webp is not in release-notes/media/",
    ]);
  });

  it("accepts media that exists in the media directory", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "media"));
    writeFileSync(join(dir, "media", "status.webp"), "");
    writeFileSync(
      join(dir, "0.2.0.json"),
      JSON.stringify(notes("0.2.0", { highlights: [{ title: "x", body: "y", media: "status.webp" }] })),
    );
    expect((await validateReleaseNotesDirectory(dir)).errors).toEqual([]);
  });

  it("rejects an uppercase media extension even when the file exists", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "media"));
    writeFileSync(join(dir, "media", "status.PNG"), "");
    writeFileSync(
      join(dir, "0.2.0.json"),
      JSON.stringify(notes("0.2.0", { highlights: [{ title: "x", body: "y", media: "status.PNG" }] })),
    );
    expect((await validateReleaseNotesDirectory(dir)).errors).not.toEqual([]);
  });

  it("exits non-zero from the command line when a file is invalid", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "0.1.1.json"), "{ not json");
    let status = 0;
    try {
      execFileSync(process.execPath, ["scripts/release-notes/validate.mjs", dir], { cwd: root, stdio: "pipe" });
    } catch (error: unknown) {
      status = (error as { status?: number }).status ?? -1;
    }
    expect(status).toBe(1);
    const output = execFileSync(process.execPath, ["scripts/release-notes/validate.mjs"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    expect(output).toMatch(/release notes valid/);
  });
});
