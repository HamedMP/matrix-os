/**
 * Mail address checks shared by every office adapter. Attendees, organisers
 * and account owners are all identified by an address.
 */
const ADDRESS = /^[^\s@<>(),;:"\\]+@[^\s@<>(),;:"\\]+\.[^\s@<>(),;:"\\]+$/;

export function normalizeMailAddress(address: string): string {
  return address.trim().toLowerCase();
}

export function sameMailAddress(a: string, b: string): boolean {
  return normalizeMailAddress(a) === normalizeMailAddress(b);
}

/** A deliberately strict check: one address, no display name, no whitespace, at most 254 characters. */
export function isValidMailAddress(address: string): boolean {
  return address.length <= 254 && ADDRESS.test(address);
}
