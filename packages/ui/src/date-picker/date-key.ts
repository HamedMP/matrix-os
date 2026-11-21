/** Local calendar date (YYYY-MM-DD) for a `Date`, without UTC shifting. */
export function toDateKey(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Parses YYYY-MM-DD as a local date; anything else is no date. */
export function fromDateKey(key: string | null | undefined): Date | undefined {
  const match = key ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(key) : null;
  if (!match) return undefined;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  // Reject dates the Date constructor would roll over, such as February 31.
  return date.getMonth() === Number(match[2]) - 1 && date.getDate() === Number(match[3]) ? date : undefined;
}
