/**
 * Map capture RMS onto the presence orb's 0…1 level. Speech RMS sits around
 * 0.02–0.3, so lift it with a square root and gain, attack instantly and
 * release softly so the orb settles instead of flickering between frames.
 */
export function orbLevel(previous: number, rms: number): number {
  const target = Math.min(1, Math.sqrt(Math.max(0, rms)) * 1.8);
  return target >= previous ? target : previous * 0.72 + target * 0.28;
}
