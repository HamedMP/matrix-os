import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SHELL_SESSION_ADJECTIVES,
  SHELL_SESSION_CREATE_ATTEMPTS,
  SHELL_SESSION_NOUNS,
  createShellSessionName,
} from "@matrix-os/contracts";

function readSwiftList(source: string, name: string): string[] {
  const match = new RegExp(`let ${name} = \\[([\\s\\S]*?)\\]`).exec(source);
  if (!match) throw new Error(`Missing Swift list: ${name}`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

function readSwiftInt(source: string, name: string): number {
  const match = new RegExp(`let ${name} = (\\d+)`).exec(source);
  if (!match) throw new Error(`Missing Swift int: ${name}`);
  return Number(match[1]);
}

describe("shell session names contract", () => {
  it("always creates plain two-word names", () => {
    const originalRandom = Math.random;
    try {
      Math.random = () => 0;
      expect(createShellSessionName()).toBe("swift-falcon");
    } finally {
      Math.random = originalRandom;
    }
  });

  it("generates lowercase two-segment names without suffix escape hatches", () => {
    for (let index = 0; index < 200; index += 1) {
      const name = createShellSessionName();
      expect(name).toMatch(/^[a-z]+-[a-z]+$/);
      expect(name.split("-")).toHaveLength(2);
    }
  });

  it("keeps the macOS word lists in sync with the shared TypeScript source", async () => {
    const swiftSource = await readFile(resolve(process.cwd(), "macos/Sources/App/ShellSessionNames.swift"), "utf8");

    expect(readSwiftList(swiftSource, "shellSessionAdjectives")).toEqual([...SHELL_SESSION_ADJECTIVES]);
    expect(readSwiftList(swiftSource, "shellSessionNouns")).toEqual([...SHELL_SESSION_NOUNS]);
    expect(readSwiftInt(swiftSource, "shellSessionCreateAttempts")).toBe(SHELL_SESSION_CREATE_ATTEMPTS);
  });
});
