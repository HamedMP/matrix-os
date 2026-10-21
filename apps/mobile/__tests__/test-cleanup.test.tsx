import { useEffect } from "react";
import { renderHook } from "@testing-library/react-native";
import { QueryClient } from "@tanstack/react-query";
import { mobileQueryClient } from "../lib/query-client";
import { disposeTestQueryClient } from "./query-test-cleanup";

const released = jest.fn();

// These ordered cases exercise the runner's between-test lifecycle. Neither
// case disposes its own resources: the shared harness must own that cleanup.
describe("mobile test cleanup", () => {
  it("mounts a hook and populates the shared query cache", () => {
    renderHook(() => useEffect(() => () => released(), []));
    mobileQueryClient.setQueryData(["test-cleanup"], "cached");
    expect(released).not.toHaveBeenCalled();
  });

  it("starts the next test with the hook unmounted and cache disposed", () => {
    expect(released).toHaveBeenCalledTimes(1);
    expect(mobileQueryClient.getQueryCache().getAll()).toHaveLength(0);
  });

  it("disposes mutation GC timers even though clearing their cache does not", async () => {
    jest.useFakeTimers();
    const client = new QueryClient();
    try {
      client.getMutationCache().build(client, { mutationFn: async () => "done" });
      expect(jest.getTimerCount()).toBe(1);
      await disposeTestQueryClient(client);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

});
