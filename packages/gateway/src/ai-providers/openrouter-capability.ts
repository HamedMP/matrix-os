export function isOpenRouterMultiHarnessEnabled(value: string | undefined): boolean {
  if (value === undefined) return true;
  return value === "1";
}
