// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useCompatibilityRepair } from "@renderer/lib/use-compatibility-repair";
import type { ApiClient } from "@renderer/lib/api";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it.each(["cloud", "local"])("does not claim alignment after a %s update leaves different source commits", async (target) => {
  let updated = false;
  const source = { commit: "b".repeat(40), ancestors: ["a".repeat(40)] };
  const api = {
    forRuntime() { return this; },
    async get(path: string) {
      if (path === "/api/system/info") return {
        version: updated ? "v2" : "v1", runningVersion: updated ? "v2" : "v1",
        build: { sha: target === "cloud" && !updated ? "a".repeat(40) : "c".repeat(40) },
      };
      return { channel: "canary", latest: { version: target === "cloud" ? "v2" : "v1" }, updateAvailable: target === "cloud" && !updated };
    },
    async post() { updated = true; return { ok: true }; },
  } as unknown as ApiClient;
  vi.stubGlobal("operator", { invoke: async (channel: string) => {
    if (channel === "app:get-version") return { version: "0.1.0", source };
    if (channel === "update:install") { updated = true; return { ok: true }; }
    return target === "local" && !updated ? { status: "ready", version: "0.2.0", release: { version: "0.2.0", notes: "Fix" } } : { status: "up-to-date" };
  } });
  const { result } = renderHook(() => useCompatibilityRepair(api, "primary", true));
  await waitFor(() => expect(result.current.plan?.targets).toEqual([target]));
  await act(async () => { await result.current.update(); });
  expect(updated).toBe(true);
  expect(result.current.complete).toBe(false);
  expect(result.current.plan?.compatibilityUpdateRequired).toBe(true);
  expect(result.current.plan?.reason).toContain("different changes installed");
});
