// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import React, { Suspense } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lazySlot } from "../../../../home/apps/mail/src/ui/slots";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const Fallback = () => <p>fallback</p>;
const show = (Slot: React.ComponentType<object>) => render(<Suspense fallback={<p>loading</p>}><Slot /></Suspense>);

describe("lazySlot", () => {
  it("uses the fallback when the module is not part of the build", () => {
    expect(lazySlot({}, "Composer", Fallback)).toBe(Fallback);
  });

  it("loads the module's named or default export", async () => {
    show(lazySlot({ "./compose/Composer.tsx": async () => ({ Composer: () => <p>named composer</p> }) }, "Composer", Fallback));
    expect(await screen.findByText("named composer")).toBeTruthy();
    cleanup();
    show(lazySlot({ "./x.tsx": async () => ({ default: () => <p>default export</p> }) }, "Composer", Fallback));
    expect(await screen.findByText("default export")).toBeTruthy();
  });

  it("falls back when the module fails to load or exports nothing usable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    show(lazySlot({ "./x.tsx": async () => Promise.reject(new TypeError("boom")) }, "Composer", Fallback));
    expect(await screen.findByText("fallback")).toBeTruthy();
    cleanup();
    show(lazySlot({ "./x.tsx": async () => ({ other: 1 }) }, "Composer", Fallback));
    expect(await screen.findByText("fallback")).toBeTruthy();
  });
});
