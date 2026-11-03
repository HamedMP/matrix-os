/** Exact local employee-link return target; never an arbitrary post-auth redirect. */
export function slackLinkReturnTarget(value: unknown): string | null {
  if (typeof value !== "string" || !/^\/slack\/link\?token=[A-Za-z0-9_-]{43}$/.test(value)) return null;
  return value;
}
