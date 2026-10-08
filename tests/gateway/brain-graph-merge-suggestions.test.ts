/** Person merge suggestions: pure scoring, the read over PGlite through the service, paging, and the route. */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrainApiError } from "../../packages/gateway/src/brain/api/types.js";
import type { BrainEntityView, BrainGraphService } from "../../packages/gateway/src/brain/contracts.js";
import { brainEntityId, createBrainGraphRoutes, type BrainGraphTables } from "../../packages/gateway/src/brain/graph/index.js";
import { personDisplay } from "../../packages/gateway/src/brain/graph/ids.js";
import {
  compactName, findMergeCandidates, listMergeSuggestions, orientCandidate, type BrainMergeCandidate, type BrainMergeInput,
  type BrainMergePerson, type BrainMergeSuggestionView,
} from "../../packages/gateway/src/brain/graph/merge-suggestions.js";
import type { RequestPrincipal } from "../../packages/gateway/src/request-principal.js";
import { OWNER, PROJECT, SCOPE, createGraphHarness, gitBody, rejectsWith, type GraphHarness } from "./helpers/brain-graph-fixtures.js";
import { brainDocumentId } from "./helpers/brain-store-helpers.js";

const ID = "3755031+hamedmp@users.noreply.github.com";
const PLAIN = "hamedmp@users.noreply.github.com";

function person(key: string, displayName = personDisplay(key), root = key): BrainMergePerson {
  return { entityId: brainEntityId("person", key), key, displayName, root: brainEntityId("person", root) };
}

const input = (persons: BrainMergePerson[], extra: Partial<BrainMergeInput> = {}): BrainMergeInput =>
  ({ persons, splits: [], pairs: [], ...extra });

/** "keyA + keyB" (sorted) to the candidate. */
function byPair(candidates: readonly BrainMergeCandidate[]): Map<string, BrainMergeCandidate> {
  return new Map(candidates.map((candidate) => [[candidate.a.key, candidate.b.key].sort().join(" + "), candidate]));
}

const signals = (candidate: BrainMergeCandidate | BrainMergeSuggestionView | undefined) =>
  candidate?.evidence.map((item) => `${item.signal}:${item.detail}${item.documents === null ? "" : `:${item.documents}`}`);

describe("person merge scoring", () => {
  it("joins the split of one committer through logins, names and trailer pairs", () => {
    const found = byPair(findMergeCandidates(input([
      person(`email:${ID}`, "Hamed"), person(`email:${PLAIN}`, "hamed"), person("name:hamedmp", "HamedMP"),
      person("name:hamed"), person("github:hamedmp"), person("name:hamed mp", "Hamed MP", `email:${PLAIN}`),
    ], { pairs: [
      { n: "name:hamed", e: `email:${ID}`, documents: 62 }, { n: "name:hamed", e: `email:${PLAIN}`, documents: 1 },
      { n: "name:hamedmp", e: `email:${ID}`, documents: 52 },
    ] })));
    const emails = found.get(`email:${ID} + email:${PLAIN}`)!;
    expect(emails.score).toBe(0.99);
    // The display names and the trailer pairs both say "hamed"; the first of equal weight is kept.
    expect(signals(emails)).toEqual(["same_github_login:hamedmp", "name_matches_login:hamedmp", "shared_name:Hamed"]);
    expect(signals(found.get(`email:${ID} + name:hamedmp`))).toEqual([
      "name_seen_with_email:hamedmp:52", "name_matches_login:hamedmp",
    ]);
    expect(found.get(`email:${ID} + name:hamed`)!.score).toBe(0.95);
    expect(found.get(`email:${PLAIN} + name:hamed`)!.score).toBe(0.75);
    expect(signals(found.get(`email:${ID} + github:hamedmp`))).toEqual(["same_github_login:hamedmp"]);
    expect(signals(found.get("github:hamedmp + name:hamedmp"))).toEqual(["name_matches_login:hamedmp"]);
    // The merged alias "hamed mp" speaks for its root, the plain noreply email.
    expect(signals(found.get(`email:${PLAIN} + name:hamedmp`))).toEqual(["name_matches_login:hamedmp", "shared_name:hamedmp"]);
    expect([...found.keys()].some((key) => key.includes("name:hamed mp"))).toBe(false);
  });

  it("orders evidence by weight, signal and detail, and keeps the strongest of one kind", () => {
    const login = "email:11+alice-s@users.noreply.github.com";
    const found = byPair(findMergeCandidates(input([
      person(login), person("name:alice s"), person("email:other@x.dev"),
      person("email:a1@x.dev", "Alice Smith"), person("email:a2@x.dev", "Alice Smith"),
      person("email:n1@x.dev", "NimaNaderi"), person("email:n2@x.dev", "NimaNaderi"),
    ], { pairs: [
      { n: "name:alice s", e: login, documents: 3 }, { n: "name:alice s", e: "email:other@x.dev", documents: 1 },
      { n: "name:alice q", e: "email:a1@x.dev", documents: 1 }, { n: "name:alice q", e: "email:a2@x.dev", documents: 1 },
      { n: "name:alice smith", e: "email:a1@x.dev", documents: 2 }, { n: "name:alice smith", e: "email:a2@x.dev", documents: 1 },
      { n: "name:nima naderi", e: "email:n1@x.dev", documents: 1 }, { n: "name:nima naderi", e: "email:n2@x.dev", documents: 1 },
    ] })));
    expect(signals(found.get(`${login} + name:alice s`))).toEqual([
      "name_matches_login:alice-s", "name_seen_with_email:alice s:3",
    ]);
    // Equal weights: by signal, then by detail; the display-name evidence is kept over the equal trailer one.
    expect(signals(found.get("email:a1@x.dev + email:a2@x.dev"))).toEqual(["shared_name:alice q:2", "shared_name:Alice Smith"]);
    expect(found.get("email:a1@x.dev + email:a2@x.dev")!.score).toBe(0.91);
    // A single-word spelling (0.5) gives way to the multi-word trailer name (0.7).
    expect(signals(found.get("email:n1@x.dev + email:n2@x.dev"))).toEqual(["shared_name:nima naderi:2"]);
  });

  it("never suggests across a split, inside one entity, from common or short names, or past the scan", () => {
    const crowd = [1, 2, 3, 4, 5].map((index) => person(`email:c${index}@x.dev`, "Bot Runner"));
    const logins = [1, 2, 3, 4, 5].map((index) => person(`email:${index}+robo@users.noreply.github.com`));
    const candidates = findMergeCandidates(input([
      person("email:alice@acme.dev", "Alice Smith"), person("name:alice smith"),
      person("name:al smith", "Al Smith", "email:alice@acme.dev"), person("name:al smith2", "Al Smith", "email:gone@x.dev"),
      person("email:support@acme.dev"), person("name:support"), person("email:al@acme.dev"), person("name:al"),
      person("linear:zed"), person("name:zed"), ...crowd, ...logins, person("name:robo"),
    ], {
      splits: [
        { aliasId: brainEntityId("person", "name:alice smith"), entityId: brainEntityId("person", "email:alice@acme.dev") },
        { aliasId: brainEntityId("person", "name:nobody"), entityId: brainEntityId("person", "email:alice@acme.dev") },
        { aliasId: brainEntityId("person", "name:al"), entityId: brainEntityId("person", "email:nobody@x.dev") },
      ],
      pairs: [{ n: "name:alice smith", e: "email:alice@acme.dev", documents: 4 }, { n: "name:ghost", e: "email:al@acme.dev", documents: 1 }],
    }));
    expect(candidates).toEqual([]);
    expect(compactName("Hamed-MP [bot]")).toBe("hamedmpbot");
  });

  it("keeps logins that differ only by punctuation apart, while a name still matches each", () => {
    const noreply = (login: string, id: number) => `email:${id}+${login}@users.noreply.github.com`;
    const found = byPair(findMergeCandidates(input([
      person("github:john-smith"), person("github:johnsmith"), person(noreply("ab-c", 1)), person(noreply("a-bc", 2)),
      person("name:john smith"),
    ])));
    expect(found.get("github:john-smith + github:johnsmith")).toBeUndefined();
    expect(found.get(`${noreply("a-bc", 2)} + ${noreply("ab-c", 1)}`)).toBeUndefined();
    expect(signals(found.get("github:john-smith + name:john smith"))).toEqual(["name_matches_login:john-smith"]);
    expect(signals(found.get("github:johnsmith + name:john smith"))).toEqual(["name_matches_login:johnsmith"]);
    expect(found.size).toBe(2);
  });

  it("matches no login or email from a name held by more than 4 entities", () => {
    const named = (count: number) => Array.from({ length: count }, (_, index) => person(`email:r${index}@x.dev`, "Bot Runner"));
    const handles = [person("github:botrunner"), person("email:bot.runner@acme.dev")];
    expect(findMergeCandidates(input([...named(5), ...handles]))).toEqual([]);
    const four = findMergeCandidates(input([...named(4), ...handles]));
    expect(four.flatMap((candidate) => candidate.evidence.map((item) => item.signal)).sort()).toEqual([
      ...Array(4).fill("name_matches_email"), ...Array(4).fill("name_matches_login"), ...Array(6).fill("shared_name"),
    ]);
  });
});

describe("person merge orientation", () => {
  it("keeps an email, then a GitHub login, then the side with more links", () => {
    const email = person("email:a@x.dev");
    const other = person("email:b@x.dev");
    const login = person("github:a");
    const name = person("name:a");
    const links = (counts: Record<string, number>) => (root: string) => counts[root] ?? 0;
    const keys = (oriented: { entity: BrainMergePerson; alias: BrainMergePerson }) => `${oriented.entity.key} <= ${oriented.alias.key}`;
    expect(keys(orientCandidate({ a: name, b: email }, links({})))).toBe("email:a@x.dev <= name:a");
    expect(keys(orientCandidate({ a: login, b: name }, links({})))).toBe("github:a <= name:a");
    expect(keys(orientCandidate({ a: login, b: email }, links({})))).toBe("email:a@x.dev <= github:a");
    expect(keys(orientCandidate({ a: email, b: other }, links({ [other.entityId]: 2 })))).toBe("email:b@x.dev <= email:a@x.dev");
    expect(keys(orientCandidate({ a: email, b: other }, links({})))).toBe("email:a@x.dev <= email:b@x.dev");
  });
});
