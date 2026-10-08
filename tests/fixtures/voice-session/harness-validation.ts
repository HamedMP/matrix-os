export const FAKE_CANONICAL_LIMITS = {
  maxCollectionEntries: 512,
  maxJournalEntries: 512,
  maxIdChars: 160,
  maxTranscriptChars: 8_000,
  maxTranscriptBytes: 32_000,
} as const;

const textEncoder = new TextEncoder();

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireIdentifier(value: unknown, field: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  if (value.length > FAKE_CANONICAL_LIMITS.maxIdChars) {
    throw new RangeError(`${field} exceeds ${FAKE_CANONICAL_LIMITS.maxIdChars} characters`);
  }
}

export function requireNonNegativeSafeInteger(value: unknown, field: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError(`${field} must be a safe integer`);
  }
  if (value < 0) {
    throw new RangeError(`${field} must be non-negative`);
  }
}

export function requireTranscript(value: unknown, field: string): void {
  if (typeof value !== "string") {
    throw new TypeError(`${field} must be a string`);
  }
  if ([...value].length > FAKE_CANONICAL_LIMITS.maxTranscriptChars) {
    throw new RangeError(`${field} exceeds ${FAKE_CANONICAL_LIMITS.maxTranscriptChars} characters`);
  }
  if (textEncoder.encode(value).byteLength > FAKE_CANONICAL_LIMITS.maxTranscriptBytes) {
    throw new RangeError(`${field} exceeds ${FAKE_CANONICAL_LIMITS.maxTranscriptBytes} bytes`);
  }
}

export function requireEnum<T extends string>(value: unknown, field: string, allowed: readonly T[]): asserts value is T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new TypeError(`${field} must be one of: ${allowed.join(", ")}`);
  }
}

export function requireCapacity(values: readonly unknown[], field: string): void {
  if (values.length >= FAKE_CANONICAL_LIMITS.maxCollectionEntries) {
    throw new RangeError(`${field} exceeds ${FAKE_CANONICAL_LIMITS.maxCollectionEntries} entries`);
  }
}
