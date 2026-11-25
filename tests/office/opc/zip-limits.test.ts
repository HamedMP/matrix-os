import { describe, expect, it, vi } from "vitest";

import { isOfficeError } from "../../../packages/office/src/errors.js";
import { InflateFailure, inflateRaw } from "../../../packages/office/src/opc/deflate.js";
import { DEFAULT_ZIP_LIMITS, createPackage, openPackage, parseZip, readRecord } from "../../../packages/office/src/opc/index.js";
import { CONTENT_TYPES_XML, checksum, handmadeZip, rawDeflate } from "./handmade-zip.js";

const MIB = 1024 * 1024;

/** 80 MiB of zeros deflates to under 100 KiB: the shape of a zip bomb. */
const ZEROS = new Uint8Array(80 * MIB);
const ZEROS_DEFLATED = rawDeflate(ZEROS, 9);
const ZEROS_CRC = checksum(ZEROS);

function bombEntry(name: string, declared: number) {
  return { name, data: "", method: 8, rawPayload: ZEROS_DEFLATED, uncompressedSize: declared, crc: ZEROS_CRC };
}

function limitFailure(action: () => unknown): { code: string; limit: unknown } {
  try {
    action();
  } catch (error) {
    if (isOfficeError(error)) return { code: error.code, limit: error.details.limit };
    throw error;
  }
  throw new Error("expected a limit to be enforced");
}

describe("ZIP limits", () => {
  it("has defaults that fit a 10 MiB file and cannot be changed", () => {
    expect(DEFAULT_ZIP_LIMITS).toEqual({ maxEntries: 5000, maxEntryBytes: 32 * MIB, maxTotalBytes: 96 * MIB });
    expect(Object.isFrozen(DEFAULT_ZIP_LIMITS)).toBe(true);
  });

  it("the bomb payload really is tiny next to what it inflates to", () => {
    expect(ZEROS_DEFLATED.length).toBeLessThan(100 * 1024);
  });

  it("refuses one entry above the default per-entry limit before inflating it", () => {
    const zip = handmadeZip([bombEntry("word/document.xml", ZEROS.length)]);
    expect(zip.length).toBeLessThan(MIB);
    expect(limitFailure(() => parseZip(zip))).toEqual({ code: "zip_limit_exceeded", limit: "maxEntryBytes" });
    // One byte over the limit is refused; the limit itself is not.
    const over = { name: "word/document.xml", data: "", method: 8, rawPayload: ZEROS_DEFLATED, crc: ZEROS_CRC };
    expect(limitFailure(() => parseZip(handmadeZip([{ ...over, uncompressedSize: 32 * MIB + 1 }])))).toEqual({ code: "zip_limit_exceeded", limit: "maxEntryBytes" });
    expect(parseZip(handmadeZip([{ ...over, uncompressedSize: 32 * MIB }])).records).toHaveLength(1);
  });

  it("refuses an archive whose entries together pass the default total limit", () => {
    // Four entries of 30 MiB each: every one is under the per-entry limit, the sum is 120 MiB.
    const thirty = rawDeflate(ZEROS.subarray(0, 30 * MIB), 9);
    const crc = checksum(ZEROS.subarray(0, 30 * MIB));
    const entries = Array.from({ length: 4 }, (_unused, index) => ({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      data: "",
      method: 8,
      rawPayload: thirty,
      uncompressedSize: 30 * MIB,
      crc,
    }));
    const zip = handmadeZip(entries);
    expect(limitFailure(() => parseZip(zip))).toEqual({ code: "zip_limit_exceeded", limit: "maxTotalBytes" });
    // Three of them fit.
    expect(parseZip(handmadeZip(entries.slice(0, 3))).records).toHaveLength(3);
  });

  it("refuses more entries than the default entry limit", () => {
    const entries = Array.from({ length: 5001 }, (_unused, index) => ({ name: `p/${index}.xml`, data: "" }));
    expect(limitFailure(() => parseZip(handmadeZip(entries)))).toEqual({ code: "zip_limit_exceeded", limit: "maxEntries" });
    expect(parseZip(handmadeZip(entries.slice(0, 5000))).records).toHaveLength(5000);
  });

  it("applies caller limits at their exact boundary", () => {
    const zip = handmadeZip([
      { name: "a.txt", data: "x".repeat(100) },
      { name: "b.txt", data: "y".repeat(100) },
    ]);
    expect(parseZip(zip, { maxEntries: 2, maxEntryBytes: 100, maxTotalBytes: 200 }).records).toHaveLength(2);
    expect(limitFailure(() => parseZip(zip, { maxEntries: 1 }))).toEqual({ code: "zip_limit_exceeded", limit: "maxEntries" });
    expect(limitFailure(() => parseZip(zip, { maxEntryBytes: 99 }))).toEqual({ code: "zip_limit_exceeded", limit: "maxEntryBytes" });
    expect(limitFailure(() => parseZip(zip, { maxTotalBytes: 199 }))).toEqual({ code: "zip_limit_exceeded", limit: "maxTotalBytes" });
  });

  it("refuses limits that are not finite, non-negative numbers", () => {
    const zip = handmadeZip([{ name: "a.txt", data: "x" }]);
    for (const maxEntries of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(limitFailure(() => parseZip(zip, { maxEntries })).code).toBe("invalid_argument");
    }
  });

  it("stops inflating an entry whose header understates its size", async () => {
    // The header claims 1000 bytes; the stream holds 80 MiB.
    const zip = handmadeZip([bombEntry("word/document.xml", 1000)]);
    const [record] = parseZip(zip).records;
    let caught: unknown;
    try {
      await readRecord(record!);
    } catch (error) {
      caught = error;
    }
    expect(isOfficeError(caught, "corrupt_package")).toBe(true);
    expect((caught as { details: { reason: string } }).details.reason).toBe("size_mismatch");
  });

  it("cancels inflation at the bound instead of producing the whole output", async () => {
    // Count the bytes that actually leave the platform decompressor.
    const RealStream = globalThis.DecompressionStream;
    let produced = 0;
    class CountingStream {
      readonly readable: ReadableStream<Uint8Array>;
      readonly writable: WritableStream<BufferSource>;
      constructor(format: CompressionFormat) {
        const real = new RealStream(format);
        this.writable = real.writable;
        this.readable = (real.readable as ReadableStream<Uint8Array>).pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              produced += chunk.length;
              controller.enqueue(chunk);
            },
          }),
        );
      }
    }
    vi.stubGlobal("DecompressionStream", CountingStream);
    try {
      let failure: unknown;
      try {
        await inflateRaw(ZEROS_DEFLATED, 4096);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(InflateFailure);
      expect((failure as InflateFailure).kind).toBe("too-large");
      expect(produced).toBeGreaterThan(4096);
      expect(produced).toBeLessThan(MIB);

      // The same stream inflates in full when the bound allows it.
      produced = 0;
      const whole = await inflateRaw(ZEROS_DEFLATED, ZEROS.length);
      expect(whole.length).toBe(ZEROS.length);
      expect(produced).toBe(ZEROS.length);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports a platform stream that refuses deflate-raw as an unsupported format", async () => {
    // Some engines expose the constructors but throw a TypeError for a format they lack.
    class RefusingStream {
      constructor(format: string) {
        throw new TypeError(`Unsupported compression format: '${format}'`);
      }
    }
    const deflated = handmadeZip([{ name: "[Content_Types].xml", data: CONTENT_TYPES_XML, method: 8 }]);
    vi.stubGlobal("DecompressionStream", RefusingStream);
    vi.stubGlobal("CompressionStream", RefusingStream);
    try {
      const inflateFailure = await inflateRaw(Uint8Array.from([3, 0]), 16).catch((error: unknown) => error);
      expect(inflateFailure).toBeInstanceOf(InflateFailure);
      expect((inflateFailure as InflateFailure).kind).toBe("unsupported");
      expect((inflateFailure as InflateFailure).cause).toBeInstanceOf(TypeError);

      await expect(openPackage(deflated)).rejects.toMatchObject({
        code: "unsupported_format",
        details: { reason: "compression_stream_unavailable" },
      });

      const pkg = createPackage();
      pkg.setPart("/doc.xml", "<d/>".repeat(200));
      await expect(pkg.save()).rejects.toMatchObject({
        code: "unsupported_format",
        details: { reason: "compression_stream_unavailable" },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("openPackage enforces the limits it is given and the lying-header bound", async () => {
    const honest = handmadeZip([
      { name: "[Content_Types].xml", data: CONTENT_TYPES_XML },
      bombEntry("word/document.xml", ZEROS.length),
    ]);
    await expect(openPackage(honest)).rejects.toMatchObject({ code: "zip_limit_exceeded" });

    const small = handmadeZip([{ name: "[Content_Types].xml", data: CONTENT_TYPES_XML }]);
    await expect(openPackage(small, { maxEntryBytes: 16 })).rejects.toMatchObject({ code: "zip_limit_exceeded" });

    // A relationships part is inflated on open, so a lying one is caught there.
    const lying = handmadeZip([{ name: "[Content_Types].xml", data: CONTENT_TYPES_XML }, bombEntry("_rels/.rels", 300)]);
    await expect(openPackage(lying)).rejects.toMatchObject({ code: "corrupt_package" });

    // Any other part is inflated on first read.
    const lazy = handmadeZip([{ name: "[Content_Types].xml", data: CONTENT_TYPES_XML }, bombEntry("word/document.xml", 300)]);
    const pkg = await openPackage(lazy);
    await expect(pkg.getPartBytes("/word/document.xml")).rejects.toMatchObject({ code: "corrupt_package" });
  });
});
