import { IsoTimestampSchema } from '@matrix-os/contracts';

/** Clamp the original UTC anniversary day; never compound February's clamp. */
export function subscriptionCreditCycle(anchorInput: string, now: Date): { start: string; end: string } | null {
  const anchor = new Date(IsoTimestampSchema.parse(anchorInput));
  if (!Number.isFinite(now.getTime()) || now.getTime() < anchor.getTime()) return null;
  const boundary = (offset: number) => {
    const first = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + offset, 1));
    const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
    return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(anchor.getUTCDate(), lastDay),
      anchor.getUTCHours(), anchor.getUTCMinutes(), anchor.getUTCSeconds(), anchor.getUTCMilliseconds()));
  };
  let offset = (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + now.getUTCMonth() - anchor.getUTCMonth();
  if (boundary(offset).getTime() > now.getTime()) offset--;
  return { start: boundary(offset).toISOString(), end: boundary(offset + 1).toISOString() };
}
