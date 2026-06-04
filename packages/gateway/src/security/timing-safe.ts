import { timingSafeEqual } from "node:crypto";

export function timingSafeStringEquals(
  actual: string | null | undefined,
  expected: string,
): boolean {
  if (!actual) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  const compareLength = Math.max(actualBuffer.length, expectedBuffer.length);
  if (compareLength === 0) return false;
  const paddedActual = Buffer.alloc(compareLength);
  const paddedExpected = Buffer.alloc(compareLength);
  actualBuffer.copy(paddedActual);
  expectedBuffer.copy(paddedExpected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(paddedActual, paddedExpected)
  );
}
