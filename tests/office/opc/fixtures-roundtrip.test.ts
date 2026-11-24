import { unzipSync } from "fflate";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  type ZipRecord,
  findMainDocumentPart,
  openPackage,
  parseZip,
} from "../../../packages/office/src/opc/index.js";

const FIXTURE_DIR = path.resolve(__dirname, "../fixtures");

function listFixtures(): string[] {
  try {
    return readdirSync(FIXTURE_DIR)
      .filter((name) => /\.(docx|xlsx)$/i.test(name))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function load(name: string): Uint8Array {
  return new Uint8Array(readFileSync(path.join(FIXTURE_DIR, name)));
}

function stored(record: ZipRecord) {
  return { ...record, compressed: Buffer.from(record.compressed).toString("base64") };
}

const fixtures = listFixtures();

describe("document fixtures", () => {
  it("finds the checked-in fixtures, so the round-trip cases below are not empty", () => {
    expect(fixtures.some((name) => name.endsWith(".docx"))).toBe(true);
    expect(fixtures.some((name) => name.endsWith(".xlsx"))).toBe(true);
  });

  describe("round trip", () => {
    it.each(fixtures)("%s is written back with every entry's stored bytes unchanged", async (name) => {
      const source = load(name);
      const before = parseZip(source).records;
      const pkg = await openPackage(source);
      for (const part of pkg.listParts({ includeRelationships: true })) {
        expect((await pkg.getPartBytes(part.name)).length).toBe(part.size);
      }
      const saved = await pkg.save();
      const after = new Map(parseZip(saved).records.map((record) => [record.name, record]));

      expect(after.size).toBe(before.length);
      for (const record of before) {
        expect(stored(after.get(record.name)!), record.name).toEqual(stored(record));
      }
      const order = [...after.keys()];
      expect(order[0]).toBe("[Content_Types].xml");
      const rest = (names: string[]) => names.filter((entry) => entry !== "[Content_Types].xml" && entry !== "_rels/.rels");
      expect(rest(order)).toEqual(rest(before.map((record) => record.name)));

      // An independent reader extracts identical content from both archives.
      const original = unzipSync(source);
      const rewritten = unzipSync(saved);
      expect(Object.keys(rewritten).sort()).toEqual(Object.keys(original).sort());
      for (const [entry, bytes] of Object.entries(original)) {
        expect(Buffer.from(rewritten[entry]!).equals(Buffer.from(bytes)), entry).toBe(true);
      }
      // Saving is stable.
      expect(Buffer.from(await (await openPackage(saved)).save()).equals(Buffer.from(saved))).toBe(true);
    });

    it.each(fixtures)("%s has a typed main document part reachable through its relationships", async (name) => {
      const pkg = await openPackage(load(name));
      const main = findMainDocumentPart(pkg);
      expect(main).toBe(name.endsWith(".docx") ? "/word/document.xml" : "/xl/workbook.xml");
      expect(pkg.getContentType(main!)).toMatch(/^application\/vnd\.openxmlformats-officedocument\..+\.main\+xml$/);
      for (const part of pkg.listParts()) {
        expect(part.contentType, part.name).not.toBeNull();
        for (const relationship of pkg.getRelationships(part.name)) {
          if (relationship.targetMode === "External") continue;
          expect(pkg.hasPart(pkg.resolveTarget(part.name, relationship.target)), `${part.name} -> ${relationship.target}`).toBe(true);
        }
      }
    });

    it.each(fixtures)("%s: editing the main part changes only that entry", async (name) => {
      const source = load(name);
      const before = parseZip(source).records;
      const pkg = await openPackage(source);
      const main = findMainDocumentPart(pkg)!;
      const text = await pkg.getPartText(main);
      pkg.setPart(main, `${text}<!-- edited -->`);
      const saved = await pkg.save();
      const after = new Map(parseZip(saved).records.map((record) => [record.name, record]));
      for (const record of before) {
        if (`/${record.name}` === main) {
          expect(after.get(record.name)!.crc32).not.toBe(record.crc32);
        } else {
          expect(stored(after.get(record.name)!), record.name).toEqual(stored(record));
        }
      }
      expect(await (await openPackage(saved)).getPartText(main)).toBe(`${text}<!-- edited -->`);
    });
  });
});
