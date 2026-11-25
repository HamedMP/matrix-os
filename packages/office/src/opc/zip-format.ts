/** ZIP record layout constants shared by the reader and the writer. */

export const SIG_LOCAL = 0x04034b50;
export const SIG_CENTRAL = 0x02014b50;
export const SIG_EOCD = 0x06054b50;
export const SIG_ZIP64_LOCATOR = 0x07064b50;

export const LOCAL_FIXED = 30;
export const CENTRAL_FIXED = 46;
export const EOCD_FIXED = 22;
export const ZIP64_LOCATOR_SIZE = 20;
export const MAX_COMMENT = 0xffff;

export const METHOD_STORED = 0;
export const METHOD_DEFLATE = 8;

export const FLAG_ENCRYPTED = 0x0001;
/** Bits 1 and 2: deflate level hint. Kept when an entry is written back unchanged. */
export const FLAG_DEFLATE_HINT = 0x0006;
export const FLAG_DATA_DESCRIPTOR = 0x0008;
export const FLAG_PATCHED = 0x0020;
export const FLAG_STRONG_ENCRYPTION = 0x0040;
export const FLAG_UTF8 = 0x0800;
export const FLAG_MASKED_HEADERS = 0x2000;

export const U16_MAX = 0xffff;
export const U32_MAX = 0xffffffff;

/** New and rewritten entries carry 1980-01-01 00:00:00 so output never depends on the clock. */
export const FIXED_DOS_TIME = 0x0000;
export const FIXED_DOS_DATE = 0x0021;

export const VERSION_NEEDED = 20;
export const VERSION_MADE_BY = 20;

/** One entry as stored in the container: compressed payload plus what describes it. */
export interface ZipRecord {
  readonly name: string;
  readonly method: 0 | 8;
  /** General purpose flags relevant to a rewrite (deflate level hint only). */
  readonly flags: number;
  /** MS-DOS time and date words, reused when the entry is written back unchanged. */
  readonly dosTime: number;
  readonly dosDate: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  /** The compressed payload exactly as it sits in the container. */
  readonly compressed: Uint8Array;
}
