/** Keep the UTF-16 budget without leaving half of a supplementary character. */
export function truncateSlackText(text: string, limit: number): string {
  const clipped = text.slice(0, limit);
  const last = clipped.charCodeAt(clipped.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? clipped.slice(0, -1) : clipped;
}
