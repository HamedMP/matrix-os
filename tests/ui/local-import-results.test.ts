import { describe, expect, it } from "vitest";
import { createLocalImportResults } from "../../packages/ui/src/chat-import/local-import-results";
describe("bounded local import outcomes", () => {
    it("publishes results in groups while preserving immediate retry and success truth", () => {
        const results = createLocalImportResults(); let snapshots = 0;
        for (let index = 0; index < 250; index++) {
            if (results.record(`key-${index}`, { status: index === 1 ? "failed" : "imported" })) {
                snapshots++; expect(Object.keys(results.snapshot()).length).toBe(index + 1);
            }
        }
        expect(snapshots).toBe(2); expect(results.importedCount).toBe(249);
        expect(results.get("key-249")?.status).toBe("imported");
        expect(Object.keys(results.snapshot())).toHaveLength(250);
        results.record("key-1", { status: "imported" }); expect(results.importedCount).toBe(250);
        results.record("key-1", { status: "imported" }); expect(results.importedCount).toBe(250);
        results.record("key-1", { status: "failed" }); expect(results.importedCount).toBe(249);
        results.clear(); expect(results.snapshot()).toEqual({}); expect(results.importedCount).toBe(0);
    });
    it("caps storage at the discovery budget, including stale or unexpected keys", () => {
        const results = createLocalImportResults();
        for (let index = 0; index < 20_001; index++) results.record(`key-${index}`, { status: "imported" });
        expect(Object.keys(results.snapshot())).toHaveLength(20_000); expect(results.get("key-20000")).toBeUndefined();
        expect(results.importedCount).toBe(20_000);
        results.record("key-0", { status: "failed" }); expect(results.importedCount).toBe(19_999);
    });
});
