import { vi } from "vitest";

const resolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;

/** Keep formatter options intact while controlling the browser location hint. */
export function mockBrowserTimeZone(timeZone: string): void {
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(function (
    this: Intl.DateTimeFormat,
  ) {
    return { ...resolvedOptions.call(this), timeZone };
  });
}
