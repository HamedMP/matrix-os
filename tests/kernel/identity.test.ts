import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  loadHandle,
  saveIdentity,
  deriveAiHandle,
  type Identity,
} from "../../packages/kernel/src/identity.js";

function tmpHome(): string {
  const dir = resolve(mkdtempSync(join(tmpdir(), "identity-")));
  mkdirSync(join(dir, "system"), { recursive: true });
  return dir;
}

describe("T210: Identity system", () => {
  let homePath: string;

  afterEach(() => {
    if (homePath) rmSync(homePath, { recursive: true, force: true });
  });

  it("loadHandle returns empty identity when handle.json missing", () => {
    homePath = tmpHome();
    const id = loadHandle(homePath);
    expect(id.handle).toBe("");
    expect(id.aiHandle).toBe("");
  });

  it("loadHandle reads handle from handle.json", () => {
    homePath = tmpHome();
    writeFileSync(join(homePath, "system", "handle.json"), JSON.stringify({
      handle: "hamed",
      aiHandle: "hamed_ai",
      displayName: "Hamed",
      createdAt: "2026-01-01T00:00:00Z",
    }));
    const id = loadHandle(homePath);
    expect(id.handle).toBe("hamed");
    expect(id.aiHandle).toBe("hamed_ai");
    expect(id.displayName).toBe("Hamed");
  });

  it("deriveAiHandle appends _ai suffix", () => {
    expect(deriveAiHandle("hamed")).toBe("hamed_ai");
    expect(deriveAiHandle("alice")).toBe("alice_ai");
  });

  it("saveIdentity writes handle.json", () => {
    homePath = tmpHome();
    const id: Identity = {
      handle: "bob",
      aiHandle: "bob_ai",
      displayName: "Bob",
      createdAt: "2026-02-01T00:00:00Z",
    };
    saveIdentity(homePath, id);

    const path = join(homePath, "system", "handle.json");
    expect(existsSync(path)).toBe(true);
    const saved = JSON.parse(readFileSync(path, "utf-8"));
    expect(saved.handle).toBe("bob");
    expect(saved.aiHandle).toBe("bob_ai");
  });

  it("loadHandle handles corrupt handle.json", () => {
    homePath = tmpHome();
    writeFileSync(join(homePath, "system", "handle.json"), "not json");
    const id = loadHandle(homePath);
    expect(id.handle).toBe("");
  });

  it("saveIdentity auto-derives aiHandle and sets createdAt", () => {
    homePath = tmpHome();
    saveIdentity(homePath, {
      handle: "alice",
      aiHandle: deriveAiHandle("alice"),
      displayName: "Alice",
      createdAt: new Date().toISOString(),
    });
    const saved = loadHandle(homePath);
    expect(saved.handle).toBe("alice");
    expect(saved.aiHandle).toBe("alice_ai");
    expect(saved.displayName).toBe("Alice");
    expect(saved.createdAt).toBeTruthy();
  });
});
