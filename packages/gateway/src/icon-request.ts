export function isExplicitIconRegeneration(body: unknown): boolean {
  return Boolean(body && typeof body === "object" && "regenerate" in body && body.regenerate === true);
}
