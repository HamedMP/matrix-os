import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SHELL_SESSION_ADJECTIVES,
  SHELL_SESSION_NOUNS,
  createShellSessionName,
} from "@matrix-os/contracts";

function readSwiftList(source: string, name: string): string[] {
  const match = new RegExp(`let ${name} = \\[([\\s\\S]*?)\\]`).exec(source);
  if (!match) throw new Error(`Missing Swift list: ${name}`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

describe("shell session names contract", () => {
  it("creates plain two-word names until collision fallback is requested", () => {
    const originalRandom = Math.random;
    try {
      Math.random = () => 0;
      expect(createShellSessionName()).toBe("swift-falcon");
      expect(createShellSessionName({ collisionFallback: true })).toBe("swift-falcon-00000");
    } finally {
      Math.random = originalRandom;
    }
  });

  it("keeps the macOS word lists in sync with the shared TypeScript source", async () => {
    const swiftSource = await readFile(resolve(process.cwd(), "macos/Sources/App/ShellSessionNames.swift"), "utf8");

    expect(readSwiftList(swiftSource, "shellSessionAdjectives")).toEqual([...SHELL_SESSION_ADJECTIVES]);
    expect(readSwiftList(swiftSource, "shellSessionNouns")).toEqual([...SHELL_SESSION_NOUNS]);
  });
});
