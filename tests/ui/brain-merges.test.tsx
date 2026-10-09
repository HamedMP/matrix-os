// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrainTimeline } from "../../packages/ui/src/brain/BrainTimeline.js";
import { brainMergeEvidenceText, brainScoreText } from "../../packages/ui/src/brain/brain-format.js";
import type { BrainMergeSuggestionView } from "../../packages/ui/src/brain/brain-types.js";
import { apiError, fakeBrainApi, FRESH, PROJECT } from "./brain-fixtures.js";

afterEach(cleanup);

const person = (entityId: string, key: string, displayName: string) => ({ entityId, kind: "person" as const, key, displayName });
const HAMED: BrainMergeSuggestionView = {
  suggestionId: "sug_1", score: 0.934,
  entity: person("ent_b", "email:hamedmp@users.noreply.github.com", "HamedMP"),
  alias: person("ent_c", "email:3755031+hamedmp@users.noreply.github.com", "hamedmp"),
  aliasKey: "person:email:3755031+hamedmp@users.noreply.github.com",
  evidence: [
    { signal: "same_github_login", detail: "hamedmp", documents: null },
    { signal: "name_matches_login", detail: "x".repeat(300), documents: null },
  ],
  counts: { entityLinks: 120, aliasLinks: 1, aliasEntities: 3 },
};
// hamedmp <- Dee: chained to HAMED (HamedMP <- hamedmp) through hamedmp.
const DEE = person("ent_d", "email:d@x.co", "Dee");
const CHAINED = { ...HAMED, suggestionId: "sug_2", entity: HAMED.alias, alias: DEE, aliasKey: "person:email:d@x.co" };

function openPeople(overrides: Parameters<typeof fakeBrainApi>[0]) {
  const api = fakeBrainApi(overrides);
  render(<BrainTimeline api={api} projectId={PROJECT} onOpenSources={vi.fn()} />);
  expect(screen.queryByRole("region", { name: "Possible duplicates" })).toBeNull();
  fireEvent.change(screen.getByRole("combobox", { name: "Timeline for" }), { target: { value: "person" } });
  return api;
}

describe("Possible duplicates", () => {
  it("merges one person into the other, undoes it, and pages", async () => {
    const api = openPeople({
      mergeSuggestions: vi.fn()
        .mockResolvedValueOnce({ items: [HAMED], nextCursor: "n2", truncated: true })
        .mockResolvedValueOnce({
          items: [{ ...HAMED, suggestionId: "sug_2", score: 0.5, evidence: [], counts: { entityLinks: 1, aliasLinks: 2, aliasEntities: 2 } }],
          nextCursor: null, truncated: false,
        }),
      updateAlias: vi.fn(async () => ({})),
    });
    const region = await screen.findByRole("region", { name: "Possible duplicates" });
    const card = (await within(region).findAllByRole("listitem"))[0]!;
    expect(api.mergeSuggestions).toHaveBeenCalledWith(PROJECT, { limit: 10, cursor: undefined });
    for (const text of ["93% likely", "120 links", "1 link", "stays", "2 more names move with hamedmp.", 'Same GitHub login "hamedmp"']) {
      expect(within(card).getByText(text)).toBeTruthy();
    }
    expect(within(card).getByText(`Name matches the GitHub login "${"x".repeat(200)}"`)).toBeTruthy();
    expect(within(region).getByText(/Only part of the people were checked/)).toBeTruthy();
    // A long name wraps inside the card instead of widening it.
    expect(within(card).getByRole("button", { name: "Merge into HamedMP" })).toHaveClass("whitespace-normal", "max-w-full", "break-all");
    fireEvent.click(within(card).getByRole("button", { name: "Merge into HamedMP" }));
    expect(await within(card).findByText("Merged hamedmp into HamedMP.")).toBeTruthy();
    expect(api.updateAlias).toHaveBeenLastCalledWith(PROJECT, "ent_b", {
      action: "merge", aliasKey: "person:email:3755031+hamedmp@users.noreply.github.com",
    });
    fireEvent.click(within(card).getByRole("button", { name: "Undo" }));
    expect(await within(card).findByRole("button", { name: "Merge into HamedMP" })).toBeTruthy();
    // Undo unmerges (leaves nothing behind), never a split that would hide the pair for good.
    expect(api.updateAlias).toHaveBeenLastCalledWith(PROJECT, "ent_b", {
      action: "unmerge", aliasKey: "person:email:3755031+hamedmp@users.noreply.github.com",
    });
    fireEvent.click(within(region).getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(within(region).getByText("50% likely")).toBeTruthy());
    expect(within(region).getByText("1 more name moves with hamedmp.")).toBeTruthy();
  });

  it("reports a refused merge and a refused undo", async () => {
    openPeople({
      mergeSuggestions: vi.fn(async () => ({ items: [HAMED], nextCursor: null, truncated: false })),
      updateAlias: vi.fn()
        .mockRejectedValueOnce(apiError("server", "alias_conflict"))
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(apiError("server", "brain_capacity")),
    });
    const region = await screen.findByRole("region", { name: "Possible duplicates" });
    const card = (await within(region).findAllByRole("listitem"))[0]!;
    fireEvent.click(within(card).getByRole("button", { name: "Merge into HamedMP" }));
    expect(await within(card).findByRole("alert")).toHaveTextContent("That alias belongs to someone else.");
    fireEvent.click(within(card).getByRole("button", { name: "Merge into HamedMP" }));
    fireEvent.click(await within(card).findByRole("button", { name: "Undo" }));
    expect(await within(card).findByRole("alert")).toHaveTextContent("The project brain is full.");
    expect(within(card).getByText("Merged hamedmp into HamedMP.")).toBeTruthy();
  });

  it("runs one change at a time, and holds a card whose person was merged away until its Undo", async () => {
    let finish = (_: unknown) => undefined as void;
    const api = openPeople({
      mergeSuggestions: vi.fn(async () => ({ items: [HAMED, CHAINED], nextCursor: null, truncated: false })),
      updateAlias: vi.fn(() => new Promise((resolve) => { finish = resolve; })),
    });
    const first = (await screen.findByRole("button", { name: "Merge into HamedMP" })).closest("li")!;
    const second = screen.getByRole("button", { name: "Merge into hamedmp" }).closest("li")!;
    fireEvent.click(within(first).getByRole("button", { name: "Merge into HamedMP" }));
    // Both at once, the gateway would join Dee to hamedmp or to HamedMP, whichever it applied first.
    fireEvent.click(within(second).getByRole("button", { name: "Merge into hamedmp" }));
    expect(api.updateAlias).toHaveBeenCalledTimes(1);
    finish({});
    await within(first).findByRole("button", { name: "Undo" });
    // hamedmp now resolves to HamedMP, so this Merge would join Dee to HamedMP and its Undo would fail.
    expect(within(second).getByRole("button", { name: "Merge into hamedmp" })).toBeDisabled();
    expect(within(second).getByText("Undo the merge of hamedmp first.")).toBeTruthy();
    fireEvent.click(within(first).getByRole("button", { name: "Undo" }));
    finish({});
    await waitFor(() => expect(within(second).getByRole("button", { name: "Merge into hamedmp" })).toBeEnabled());
  });

  it("shows each reason once and at most five", async () => {
    const login = { signal: "same_github_login", detail: "hamedmp", documents: null };
    const names = ["a", "b", "c", "d", "e"].map((detail) => ({ signal: "shared_name", detail, documents: null }));
    openPeople({
      mergeSuggestions: vi.fn(async () => ({
        items: [{ ...HAMED, evidence: [login, login, ...names] }], nextCursor: null, truncated: false,
      })),
    });
    const why = await screen.findByRole("list", { name: "Why" });
    expect(within(why).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      'Same GitHub login "hamedmp"', 'Both go by "a"', 'Both go by "b"', 'Both go by "c"', 'Both go by "d"',
    ]);
  });

  it("shows an empty list and a failed load, and words every reason", async () => {
    openPeople({
      mergeSuggestions: vi.fn()
        .mockResolvedValueOnce({ items: [], nextCursor: null, truncated: false })
        .mockRejectedValueOnce(apiError("notFound")),
    });
    expect(await screen.findByText("No likely duplicates.")).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Timeline for" }), { target: { value: "file" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Timeline for" }), { target: { value: "person" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("This part of the Company Brain is not turned on yet.");
    expect(brainScoreText(1.4)).toBe("100% likely");
    expect(brainScoreText(-2)).toBe("0% likely");
    const reason = (signal: string, documents: number | null = null) => brainMergeEvidenceText({ signal, detail: "ann", documents });
    expect(reason("name_matches_email")).toBe('Name matches the email "ann"');
    expect(reason("name_seen_with_email", 4)).toBe('Name "ann" was seen with this email in 4 documents');
    expect(reason("name_seen_with_email")).toBe('Name "ann" was seen with this email');
    expect(reason("shared_name")).toBe('Both go by "ann"');
    expect(reason("new_signal")).toBe('Also seen as "ann"');
  });
});

describe("Finding people and following", () => {
  it("pages the people found, reads the same request again, and says what to try next", async () => {
    const api = openPeople({
      mergeSuggestions: vi.fn(async () => ({ items: [], nextCursor: null, truncated: false })),
      entities: vi.fn()
        .mockResolvedValueOnce({ items: [person("ent_a", "email:a@x.co", "Ann")], nextCursor: "p2" })
        .mockResolvedValueOnce({ items: [person("ent_b", "email:b@x.co", "Bo")], nextCursor: null })
        .mockResolvedValueOnce({ items: [], nextCursor: null }),
      timeline: vi.fn(async () => ({ entity: person("ent_f", "a.ts", "a.ts"), items: [], nextCursor: null, freshness: FRESH })),
    });
    const show = (value: string) => {
      fireEvent.change(screen.getByRole("textbox", { name: "Name, path or spec" }), { target: { value } });
      fireEvent.click(screen.getByRole("button", { name: "Show" }));
    };
    show("a");
    const people = await screen.findByRole("list", { name: "People" });
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(within(people).getAllByRole("button")).toHaveLength(2));
    expect(api.entities).toHaveBeenLastCalledWith(PROJECT, { kind: "person", q: "a", limit: 10, cursor: "p2" });
    show("a");
    const hint = await screen.findByText("Try part of the name, or an email.");
    expect(hint.parentElement!.parentElement!.querySelector("svg")).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Timeline for" }), { target: { value: "file" } });
    show("a.ts");
    expect(await screen.findByText("Check the name, or sync its sources in Sources.")).toBeTruthy();
    show("a.ts");
    await waitFor(() => expect(api.timeline).toHaveBeenCalledTimes(2));
  });
});
