import { describe, expect, it } from "vitest";
import { orderRailItems, moveRailItem, parseRailOrderPreference } from "@desktop/renderer/src/features/work/work-rail/rail-order";

describe("Chat rail presentation order", () => {
  const items = [{id:"older", updatedAt:"2026-10-02T00:00:00Z", createdAt:"2026-10-01T00:00:00Z"}, {id:"newer", updatedAt:"2026-10-03T00:00:00Z", createdAt:"2026-10-02T00:00:00Z"}];
  it("uses actual update times without mutating canonical data", () => {
    expect(orderRailItems(items, "lastUpdated", ["older", "newer"]).map(item=>item.id)).toEqual(["newer", "older"]);
    expect(items.map(item=>item.id)).toEqual(["older", "newer"]);
  });
  it("keeps saved manual IDs stable and appends new IDs deterministically", () => {
    const newlyObserved = {id:"latest", updatedAt:"2026-10-04T00:00:00Z", createdAt:"2026-10-04T00:00:00Z"};
    expect(orderRailItems([newlyObserved,...items], "manual", ["older", "newer"]).map(item=>item.id)).toEqual(["older", "newer", "latest"]);
    expect(orderRailItems([...items].reverse(), "manual", []).map(item=>item.id)).toEqual(["older", "newer"]);
  });
  it("moves only known sibling IDs, without duplicates or stale references", () => {
    expect(moveRailItem(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
    expect(moveRailItem(["a", "b", "c"], "a", "c")).toEqual(["b", "c", "a"]);
    expect(moveRailItem(["a", "b"], "missing", "a")).toEqual(["a", "b"]);
  });
  it("rejects corrupt preferences and caps persisted IDs", () => {
    expect(parseRailOrderPreference('{"mode":"bogus","chatIds":[]}')).toEqual({mode:"lastUpdated",chatIds:[],projectIds:[]});
    expect(parseRailOrderPreference('broken')).toEqual({mode:"lastUpdated",chatIds:[],projectIds:[]});
    expect(parseRailOrderPreference(" ".repeat(600_001))).toEqual({mode:"lastUpdated",chatIds:[],projectIds:[]});
    expect(parseRailOrderPreference(JSON.stringify({mode:"manual", chatIds:["a","a",...Array.from({length:1200},(_,i)=>`id${i}`)],projectIds:[]})).chatIds).toHaveLength(1000);
  });
});
