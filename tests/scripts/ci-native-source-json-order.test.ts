import { describe, expect, it, vi } from "vitest";
import { resolveDedicatedMergeParents } from "../../scripts/ci/dedicated-merge.mjs";
import { nativePins, nativeStackFixture } from "./helpers/native-stack-fixture";

const repo = { owner: "HamedMP", repo: "matrix-os" };
const reordered = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).reverse());

describe("native source identity is independent of JSON property order", () => {
  it.each(["child", "parent", "child-base", "parent-base"])("accepts identical %s metadata in a different property order", async variant => {
    const f = nativeStackFixture();
    const get = f.github.rest.pulls.get;
    let parentReads = 0;
    f.github.rest.pulls.get = vi.fn(async (args: { pull_number: number }) => {
      const result = await get(args);
      const parent = args.pull_number === f.parent.number;
      if (parent) parentReads++;
      if ((variant.startsWith("child") && !parent) || (variant.startsWith("parent") && parent && parentReads > 1)) {
        if (variant.endsWith("base")) result.data.stack.base = reordered(result.data.stack.base);
        else result.data.stack = reordered(result.data.stack);
      }
      return result;
    });
    expect(await resolveDedicatedMergeParents(f.github, repo, f.pull)).toEqual(f.snapshot.mergeParents);
  });

  it("accepts identical official stack base metadata in a different property order", async () => {
    const f = nativeStackFixture();
    f.stack.base.sha = nativePins.trunk;
    const get = f.github.request;
    let reads = 0;
    f.github.request = vi.fn(async (...args: unknown[]) => {
      const result = await get(...args);
      if (++reads > 1) result.data.base = reordered(result.data.base);
      return result;
    });
    expect(await resolveDedicatedMergeParents(f.github, repo, f.pull)).toEqual(f.snapshot.mergeParents);
  });

  it.each(["child", "parent"].flatMap(member => ["id", "number", "size", "position", "base-ref", "base-sha"].map(field => [member, field] as const)))("still rejects a real final %s membership change to %s", async (member, field) => {
    const f = nativeStackFixture();
    const get = f.github.rest.pulls.get;
    let parentReads = 0;
    f.github.rest.pulls.get = vi.fn(async (args: { pull_number: number }) => {
      const result = await get(args);
      const parent = args.pull_number === f.parent.number;
      if (parent) parentReads++;
      if ((member === "child" && !parent) || (member === "parent" && parent && parentReads > 1)) {
        if (field === "base-ref") result.data.stack.base.ref = "other";
        else if (field === "base-sha") result.data.stack.base.sha = nativePins.head;
        else result.data.stack[field]++;
      }
      return result;
    });
    await expect(resolveDedicatedMergeParents(f.github, repo, f.pull)).rejects.toThrow(/stale/);
  });
  it.each(["ref", "sha"])("still rejects a changed official stack base %s", async field => {
    const f = nativeStackFixture();
    f.stack.base.sha = nativePins.trunk;
    const get = f.github.request;
    let reads = 0;
    f.github.request = vi.fn(async (...args: unknown[]) => {
      const result = await get(...args);
      if (++reads > 1) result.data.base[field] = field === "ref" ? "other" : nativePins.head;
      return result;
    });
    await expect(resolveDedicatedMergeParents(f.github, repo, f.pull)).rejects.toThrow();
  });
});
