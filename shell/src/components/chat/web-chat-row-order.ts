/** Keep server order for unranked rows and apply the current manual preference to every placement. */
export function orderWebChatRows<T>(rows: readonly T[], ids: readonly string[] | undefined, id: (row: T) => string): T[] {
  if (!ids) return [...rows];
  const ranks = new Map(ids.slice(0, 1000).map((value, index) => [value, index]));
  return rows.map((row, index) => ({ row, index })).sort((a, b) =>
    (ranks.get(id(a.row)) ?? -1) - (ranks.get(id(b.row)) ?? -1) || a.index - b.index,
  ).map(item => item.row);
}
