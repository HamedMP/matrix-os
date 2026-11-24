import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { upgradeCodexConsentAlias } from "../../packages/gateway/src/ai-providers/codex-consent-upgrade.js";
import { bindNativeAccountMetadata } from "../../packages/gateway/src/ai-providers/native-account-metadata-binding.js";

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const metadata = () => bindNativeAccountMetadata({ accountLabel: "owner@example.test", authMethod: "terminal",
  checkedAt: new Date().toISOString(), staleAfter: new Date(Date.now() + 30000).toISOString() }, async () => true,
"legacy-proof", { generation: "durable-owner" });

// ENG-523: concurrent Codex admissions may all record the same alias at once.
it("serializes concurrent consent upgrades without losing or corrupting the alias", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-consent-upgrade-")); homes.push(home);
  const results = await Promise.all(Array.from({ length: 12 }, () => upgradeCodexConsentAlias(home, sha("legacy-proof"), metadata())));
  const expected = { version: 1, saved: sha("legacy-proof"), durable: sha("durable-owner") };
  expect(results).toEqual(Array.from({ length: 12 }, () => expected));
  expect(JSON.parse(await readFile(join(home, "system/ai-providers/codex-consent-alias.json"), "utf8"))).toEqual(expected);
  expect(await readdir(join(home, "system/ai-providers"))).toEqual(["codex-consent-alias.json"]);
});
