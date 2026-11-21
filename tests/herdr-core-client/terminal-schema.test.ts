import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HcTerminalSchema } from "@matrix-os/herdr-core-client/terminal";

const PACKAGE_SRC = join(__dirname, "../../packages/herdr-core-client/src");
// Bidirectional overrides/isolates and zero-width marks render as nothing, so a
// reviewer cannot see them in source (the "Trojan Source" class of defect).
const INVISIBLE_CONTROLS = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u;

const terminal = (statusMessage: string) => ({ id: "t1", title: "build", status: "blocked", statusMessage });

describe("herdr-core terminal status messages", () => {
  it.each([
    ["left-to-right mark", "\u200e"],
    ["right-to-left mark", "\u200f"],
    ["right-to-left override", "\u202e"],
    ["first strong isolate", "\u2068"],
    ["C0 control", "\u0007"],
    ["C1 control", "\u009b"],
  ])("rejects a status message carrying a %s", (_name, control) => {
    expect(HcTerminalSchema.safeParse(terminal(`approve ${control}migration?`)).success).toBe(false);
  });

  it("accepts ordinary text, including non-Latin scripts", () => {
    expect(HcTerminalSchema.safeParse(terminal("approve the migration? — שלום")).success).toBe(true);
  });

  it("keeps blocked characters as readable escapes in the package source", () => {
    for (const file of readdirSync(PACKAGE_SRC).filter((name) => name.endsWith(".ts"))) {
      expect({ file, invisible: INVISIBLE_CONTROLS.test(readFileSync(join(PACKAGE_SRC, file), "utf8")) })
        .toEqual({ file, invisible: false });
    }
  });
});
