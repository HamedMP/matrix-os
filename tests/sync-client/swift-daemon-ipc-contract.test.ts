import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Matrix Sync Swift daemon IPC compatibility", () => {
  it("does not interpolate arbitrary daemon codes into user-visible errors", async () => {
    const source = await readFile(resolve(process.cwd(), "apps/menu-bar/Sources/DaemonClient.swift"), "utf-8");
    expect(source).not.toContain('request failed (\\(code))');
  });
  it("sends the versioned request envelope required by daemon IPC v1", async () => {
    const source = await readFile(
      resolve(process.cwd(), "apps/menu-bar/Sources/DaemonClient.swift"),
      "utf-8",
    );

    expect(source).toContain('"id": requestID');
    expect(source).toContain('"v": 1');
    expect(source).toContain('"command": command');
    expect(source).toContain('"args": args');
  });

  it("parses structured daemon errors instead of assuming a string", async () => {
    const source = await readFile(
      resolve(process.cwd(), "apps/menu-bar/Sources/DaemonClient.swift"),
      "utf-8",
    );

    expect(source).toContain('json["error"] as? [String: Any]');
    expect(source).toContain("case requestFailed(String)");
  });

  it("awaits pause and resume failures before changing visible state", async () => {
    const source = await readFile(
      resolve(process.cwd(), "apps/menu-bar/Sources/MatrixSyncApp.swift"),
      "utf-8",
    );

    expect(source).not.toContain("try? await daemonClient?.sendCommand");
    expect(source).toContain("lastError");
  });
});
