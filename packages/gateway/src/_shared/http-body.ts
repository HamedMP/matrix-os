import type { Context } from "hono";

export function requestHasBody(c: Context): boolean {
  const contentLength = c.req.header("content-length");
  if (contentLength !== undefined) {
    const parsed = Number(contentLength);
    if (Number.isNaN(parsed)) {
      if (c.req.header("transfer-encoding")) return true;
      return Boolean(c.req.header("content-type") && c.req.raw.body !== null);
    }
    return !Number.isFinite(parsed) || parsed > 0;
  }
  if (c.req.header("transfer-encoding")) return true;
  return Boolean(c.req.header("content-type") && c.req.raw.body !== null);
}
