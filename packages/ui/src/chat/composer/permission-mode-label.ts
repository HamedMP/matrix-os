/** Title-cases a provider permission mode id such as `full_access`. */
export function chatPermissionModeLabel(mode: string): string {
  return mode
    .split("_")
    .map((word) => `${word.charAt(0).toLocaleUpperCase()}${word.slice(1)}`)
    .join(" ");
}
