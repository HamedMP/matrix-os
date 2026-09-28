#!/usr/bin/env node
// Prune old host-bundle versions from the bundles bucket.
//
//   node scripts/host-bundle-prune.mjs plan            read-only; writes a plan file, deletes nothing
//   node scripts/host-bundle-prune.mjs apply <plan>    deletes exactly the plan's keys after re-checking references
//
// Required env: PLATFORM_DATABASE_URL, R2_BUNDLES_ENDPOINT, R2_BUNDLES_BUCKET,
//   R2_BUNDLES_ACCESS_KEY_ID, R2_BUNDLES_SECRET_ACCESS_KEY
// Optional env: KEEP_PER_CHANNEL (default 3), KEEP_RECENT_DAYS (default 14), KEEP_VERSIONS (comma list),
//   PLAN_FILE, PLATFORM_URL + PLATFORM_SECRET (live fleet versions), CONFIRM_DELETE_KEYS (apply), DELETE_LOG
// See docs/dev/releases.md "Pruning old host bundles".
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PREFIX = "system-bundles/";
const OBJECTS_SEGMENT = "objects";
const LIVE_SNAPSHOT_STATES = ["candidate", "building", "sanitizing", "validating", "ready"];
const MAX_PLAN_AGE_HOURS = 24;

/** Reasons each version must be kept, from platform references and operator pins. */
export function keepReasons(input) {
  const { now, keepPerChannel, keepRecentDays, pinned = [], fleetVersions = [] } = input;
  const reasons = new Map();
  const keep = (version, why) => {
    if (!version) return;
    if (!reasons.has(version)) reasons.set(version, new Set());
    reasons.get(version).add(why);
  };
  for (const row of input.channels) keep(row.version, `current ${row.channel} pointer`);
  for (const row of input.history) keep(row.version, `last ${keepPerChannel} of ${row.channel}`);
  for (const row of input.machines) {
    keep(row.image_version, "machine installed version");
    keep(row.target_bundle_version, "machine target version");
  }
  for (const row of input.jobs) keep(row.target_bundle_version, "unfinished provisioning job");
  for (const row of input.leases) keep(row.target_bundle_version, "active snapshot lease");
  for (const row of input.snapshots) keep(row.bundle_version, `golden snapshot (${row.state})`);
  for (const version of fleetVersions) keep(version, "live fleet runtime version");
  for (const version of pinned) keep(version, "KEEP_VERSIONS");
  const recentCutoff = now - keepRecentDays * 86_400_000;
  for (const row of input.releases) {
    if (Date.parse(row.created_at) >= recentCutoff) keep(row.version, `published within ${keepRecentDays} days`);
  }
  return reasons;
}

function classify(objects) {
  const byVersion = new Map();
  const contentObjects = [];
  const unrecognized = [];
  for (const item of objects) {
    const [segment, ...tail] = item.key.slice(PREFIX.length).split("/");
    if (!item.key.startsWith(PREFIX)) unrecognized.push(item);
    else if (segment === OBJECTS_SEGMENT && tail[0] === "sha256" && tail.length === 2) contentObjects.push(item);
    else if (segment && tail.length > 0 && segment !== OBJECTS_SEGMENT && segment !== "channels") {
      if (!byVersion.has(segment)) byVersion.set(segment, []);
      byVersion.get(segment).push(item);
    } else unrecognized.push(item);
  }
  return { byVersion, contentObjects, unrecognized };
}

/**
 * Decide which bucket keys can be deleted. `manifestShas` maps each kept version that has an
 * incremental manifest to the shas it lists, or null when the manifest could not be read.
 */
export function decidePrune(input, { manifestShas = new Map() } = {}) {
  const reasons = keepReasons(input);
  const releases = new Map(input.releases.map((row) => [row.version, row]));
  const recentCutoff = input.now - input.keepRecentDays * 86_400_000;
  const protectedKeys = new Set();
  for (const version of reasons.keys()) {
    const row = releases.get(version);
    if (row) for (const key of [row.bundle_key, row.checksum_key, row.incremental_manifest_key]) if (key) protectedKeys.add(key);
  }

  const { byVersion, contentObjects, unrecognized } = classify(input.objects);
  const report = [];
  const deleteKeys = [];
  for (const [version, items] of byVersion) {
    const bytes = items.reduce((sum, item) => sum + item.size, 0);
    const row = releases.get(version);
    const newest = Math.max(...items.map((item) => item.modified?.getTime?.() ?? input.now));
    let decision = "DELETE";
    let why = row ? "no channel, machine, job, lease, snapshot or recent reference" : "no release record (orphaned upload)";
    if (reasons.has(version)) { decision = "KEEP"; why = [...reasons.get(version)].join("; "); }
    else if (!row && newest >= recentCutoff) { decision = "KEEP"; why = `no release record, uploaded within ${input.keepRecentDays} days`; }
    if (decision === "DELETE") for (const item of items) if (!protectedKeys.has(item.key)) deleteKeys.push(item.key);
    report.push({ version, channel: row?.channel ?? "-", created: row?.created_at ?? new Date(newest).toISOString(), bytes, decision, why });
  }

  let content = { kept: contentObjects.length, deleted: 0, deletedBytes: 0, failSafe: false };
  if (contentObjects.length > 0) {
    const keptShas = new Set();
    for (const version of reasons.keys()) {
      if (!releases.get(version)?.incremental_manifest_key) continue;
      const shas = manifestShas.get(version);
      if (!Array.isArray(shas)) { content.failSafe = true; break; }
      for (const sha of shas) keptShas.add(sha);
    }
    if (!content.failSafe) {
      const doomed = contentObjects.filter((item) => !keptShas.has(item.key.split("/").pop()));
      for (const item of doomed) deleteKeys.push(item.key);
      content = { kept: contentObjects.length - doomed.length, deleted: doomed.length,
        deletedBytes: doomed.reduce((sum, item) => sum + item.size, 0), failSafe: false };
    }
  }

  if (deleteKeys.some((key) => !key.startsWith(PREFIX))) throw new Error("refusing: a planned key is outside system-bundles/");
  if (report.length > 0 && report.every((row) => row.decision === "DELETE")) throw new Error("refusing: every version would be deleted");
  report.sort((a, b) => a.created.localeCompare(b.created));
  const missingPointers = input.channels.filter((row) => !byVersion.has(row.version)).map((row) => `${row.channel}=${row.version}`);
  return { report, deleteKeys: deleteKeys.sort(), content, unrecognized, missingPointers, keptVersions: [...reasons.keys()] };
}

export function validatePlanForApply(plan, { bucket, confirm, now }) {
  if (plan.bucket !== bucket) throw new Error(`plan is for bucket ${plan.bucket}, not ${bucket}`);
  const ageHours = (now - Date.parse(plan.generatedAt)) / 3_600_000;
  if (!(ageHours >= 0 && ageHours <= MAX_PLAN_AGE_HOURS)) {
    throw new Error(`plan is ${ageHours.toFixed(1)} hours old; regenerate it (limit ${MAX_PLAN_AGE_HOURS}h)`);
  }
  if (!Array.isArray(plan.deleteKeys) || plan.deleteKeys.length === 0) throw new Error("plan has no keys");
  for (const key of plan.deleteKeys) {
    if (typeof key !== "string" || !key.startsWith(PREFIX) || key.split("/").some((part) => part === "" || part === "..")) {
      throw new Error(`refusing unsafe key: ${key}`);
    }
  }
  if (confirm !== String(plan.deleteKeys.length)) {
    throw new Error(`set CONFIRM_DELETE_KEYS=${plan.deleteKeys.length} to confirm deleting the ${plan.deleteKeys.length} keys in this plan`);
  }
}

const isSharedObjectKey = (key) => key.startsWith(`${PREFIX}${OBJECTS_SEGMENT}/`);
const versionOfKey = (key) => (isSharedObjectKey(key) ? null : key.slice(PREFIX.length).split("/")[0]);

/** Keys both the saved plan and a fresh decision mark for deletion, version directories first. */
export function keysToApply(planKeys, freshKeys) {
  const fresh = new Set(freshKeys);
  const agreed = planKeys.filter((key) => fresh.has(key));
  return [...agreed.filter((key) => !isSharedObjectKey(key)), ...agreed.filter(isSharedObjectKey)];
}

/**
 * Re-check one batch against references read just before deleting it. Versions kept since the
 * fresh decision are skipped; if any of them has an incremental manifest, shared objects stop.
 */
export function batchKeysToDelete(batch, { baselineKept, currentKept, releases }) {
  const newlyKept = [...currentKept].filter((version) => !baselineKept.has(version));
  const stopSharedObjects = newlyKept.some((version) => releases.get(version)?.incremental_manifest_key);
  const newlyKeptSet = new Set(newlyKept);
  const keys = [];
  const skipped = [];
  for (const key of batch) {
    const version = versionOfKey(key);
    if (version === null ? stopSharedObjects : newlyKeptSet.has(version)) skipped.push(key);
    else keys.push(key);
  }
  return { keys, skipped, stopSharedObjects };
}

// ---------------------------------------------------------------- I/O (CLI only)

function requireEnv(env, names) {
  for (const name of names) if (!env[name]) throw new Error(`${name} is required`);
}

async function loadReferences(env, keepPerChannel) {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: env.PLATFORM_DATABASE_URL, statement_timeout: 30_000,
    query_timeout: 35_000, connectionTimeoutMillis: 15_000 });
  await client.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    const q = async (text, values = []) => (await client.query(text, values)).rows;
    const refs = {
      releases: await q(`SELECT version, channel, created_at, bundle_key, checksum_key, incremental_manifest_key FROM host_bundle_releases`),
      channels: await q(`SELECT channel, version FROM host_bundle_channels`),
      history: await q(`SELECT channel, version FROM (SELECT channel, version,
        row_number() OVER (PARTITION BY channel ORDER BY promoted_at DESC) AS rank
        FROM host_bundle_release_channels) ranked WHERE rank <= $1`, [keepPerChannel]),
      machines: await q(`SELECT image_version, target_bundle_version FROM user_machines WHERE deleted_at IS NULL`),
      jobs: await q(`SELECT target_bundle_version FROM provisioning_jobs
        WHERE completed_at IS NULL AND target_bundle_version IS NOT NULL`),
      leases: await q(`SELECT target_bundle_version FROM golden_snapshot_leases WHERE released_at IS NULL`),
      snapshots: await q(`SELECT bundle_version, state FROM golden_snapshots WHERE state = ANY($1)`, [LIVE_SNAPSHOT_STATES]),
    };
    await client.query("ROLLBACK");
    return refs;
  } finally {
    await client.end();
  }
}

async function loadFleetVersions(env) {
  if (!env.PLATFORM_URL || !env.PLATFORM_SECRET) return null;
  const response = await fetch(`${env.PLATFORM_URL.replace(/\/$/, "")}/vps/fleet`, {
    headers: { authorization: `Bearer ${env.PLATFORM_SECRET}` }, redirect: "error", signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GET /vps/fleet failed: ${response.status}`);
  const body = await response.json();
  // A truncated list could hide a machine running a version its database row does not record.
  if (body.truncated) throw new Error("refusing: GET /vps/fleet was truncated, so running versions cannot all be protected");
  const rows = Array.isArray(body.machines) ? body.machines : [];
  return rows.flatMap((row) => [row.runtimeVersion, row.imageVersion].filter((v) => typeof v === "string" && v));
}

async function createStorage(env) {
  const s3 = await import("@aws-sdk/client-s3");
  const client = new s3.S3Client({ region: "auto", endpoint: env.R2_BUNDLES_ENDPOINT,
    credentials: { accessKeyId: env.R2_BUNDLES_ACCESS_KEY_ID, secretAccessKey: env.R2_BUNDLES_SECRET_ACCESS_KEY } });
  const bucket = env.R2_BUNDLES_BUCKET;
  return {
    async list() {
      const objects = [];
      let token;
      do {
        const page = await client.send(new s3.ListObjectsV2Command({ Bucket: bucket, Prefix: PREFIX, ContinuationToken: token }),
          { abortSignal: AbortSignal.timeout(60_000) });
        for (const item of page.Contents ?? []) if (item.Key) objects.push({ key: item.Key, size: item.Size ?? 0, modified: item.LastModified });
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return objects;
    },
    async manifestShas(key) {
      const result = await client.send(new s3.GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(60_000) });
      const manifest = JSON.parse(await result.Body.transformToString());
      if (!Array.isArray(manifest.files)) throw new Error("manifest has no files[]");
      return manifest.files.map((file) => file.sha256).filter((sha) => typeof sha === "string");
    },
    async deleteBatch(keys) {
      const result = await client.send(new s3.DeleteObjectsCommand({ Bucket: bucket,
        Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: false } }), { abortSignal: AbortSignal.timeout(120_000) });
      return { deleted: (result.Deleted ?? []).map((item) => item.Key), errors: result.Errors ?? [] };
    },
    destroy() { client.destroy(); },
  };
}

const gib = (bytes) => `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
const STORAGE_ENV = ["PLATFORM_DATABASE_URL", "R2_BUNDLES_ENDPOINT", "R2_BUNDLES_BUCKET", "R2_BUNDLES_ACCESS_KEY_ID", "R2_BUNDLES_SECRET_ACCESS_KEY"];

/** Current references (and live fleet versions when configured) as prune input, without objects. */
async function loadInput(env, rules) {
  const refs = await loadReferences(env, rules.keepPerChannel);
  const fleetVersions = await loadFleetVersions(env);
  return { ...refs, pinned: rules.pinned, fleetVersions: fleetVersions ?? [], fleetChecked: fleetVersions !== null,
    keepPerChannel: rules.keepPerChannel, keepRecentDays: rules.keepRecentDays, now: Date.now() };
}

/** A full decision from live references, the bucket listing and kept versions' manifests. */
async function decideFromLiveState(env, storage, rules) {
  const input = { ...(await loadInput(env, rules)), objects: await storage.list() };
  const manifestShas = new Map();
  const releases = new Map(input.releases.map((row) => [row.version, row]));
  if (input.objects.some((item) => isSharedObjectKey(item.key))) {
    for (const version of keepReasons(input).keys()) {
      const key = releases.get(version)?.incremental_manifest_key;
      if (!key) continue;
      try { manifestShas.set(version, await storage.manifestShas(key)); }
      catch (error) { manifestShas.set(version, null); console.warn(`manifest unreadable for kept version ${version}: ${error.name}`); }
    }
  }
  return { input, plan: decidePrune(input, { manifestShas }) };
}

async function runPlan(env) {
  requireEnv(env, STORAGE_ENV);
  const keepPerChannel = Number(env.KEEP_PER_CHANNEL ?? 3);
  const keepRecentDays = Number(env.KEEP_RECENT_DAYS ?? 14);
  if (!Number.isInteger(keepPerChannel) || keepPerChannel < 2) throw new Error("KEEP_PER_CHANNEL must be an integer >= 2");
  if (!(keepRecentDays >= 1)) throw new Error("KEEP_RECENT_DAYS must be >= 1");
  const pinned = (env.KEEP_VERSIONS ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  const storage = await createStorage(env);
  try {
    const { input, plan } = await decideFromLiveState(env, storage, { keepPerChannel, keepRecentDays, pinned });
    const refs = input;
    const objects = input.objects;
    const fleetVersions = input.fleetChecked ? input.fleetVersions : null;

    const kept = plan.report.filter((row) => row.decision === "KEEP");
    const doomed = plan.report.filter((row) => row.decision === "DELETE");
    console.log(`bucket ${env.R2_BUNDLES_BUCKET}: ${objects.length} objects under ${PREFIX}, ${plan.report.length} versions, ${refs.releases.length} release records`);
    console.log(`rules: channel pointers, last ${keepPerChannel} promotions per channel, machine/job/lease/snapshot references,`
      + ` releases newer than ${keepRecentDays} days${fleetVersions ? ", live fleet versions" : " (live fleet versions NOT checked)"}${pinned.length ? ", KEEP_VERSIONS" : ""}`);
    console.log("");
    console.log(["DECISION", "SIZE".padStart(11), "CREATED".padEnd(24), "CHANNEL".padEnd(8), "VERSION", "REASON"].join("  "));
    for (const row of plan.report) {
      console.log([row.decision.padEnd(8), gib(row.bytes).padStart(11), row.created.slice(0, 24).padEnd(24),
        String(row.channel).padEnd(8), row.version, `(${row.why})`].join("  "));
    }
    console.log("");
    console.log(`KEEP   ${kept.length} versions, ${gib(kept.reduce((s, r) => s + r.bytes, 0))}`);
    console.log(`DELETE ${doomed.length} versions, ${gib(doomed.reduce((s, r) => s + r.bytes, 0))}`);
    console.log(plan.content.failSafe
      ? `shared objects/sha256: all ${plan.content.kept} kept (a kept manifest was unreadable)`
      : `shared objects/sha256: ${plan.content.kept} kept, ${plan.content.deleted} unreferenced (${gib(plan.content.deletedBytes)})`);
    if (plan.unrecognized.length) console.log(`left alone (unrecognized layout): ${plan.unrecognized.length} objects`);
    if (plan.missingPointers.length) console.log(`WARNING: channel pointers with no objects in the bucket: ${plan.missingPointers.join(", ")}`);

    const planFile = env.PLAN_FILE ?? `host-bundle-prune-plan-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}.json`;
    await writeFile(planFile, `${JSON.stringify({ generatedAt: new Date().toISOString(), bucket: env.R2_BUNDLES_BUCKET,
      keepPerChannel, keepRecentDays, keepVersions: pinned, fleetChecked: input.fleetChecked,
      deleteKeys: plan.deleteKeys }, null, 2)}\n`, { flag: "wx" });
    console.log(`plan written to ${planFile} (${plan.deleteKeys.length} keys). Nothing was deleted.`);
  } finally {
    storage.destroy();
  }
}

async function runApply(env, planPath) {
  if (!planPath) throw new Error("usage: host-bundle-prune.mjs apply <plan.json>");
  requireEnv(env, STORAGE_ENV);
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  validatePlanForApply(plan, { bucket: env.R2_BUNDLES_BUCKET, confirm: env.CONFIRM_DELETE_KEYS, now: Date.now() });
  if (plan.fleetChecked && !(env.PLATFORM_URL && env.PLATFORM_SECRET)) {
    throw new Error("the plan checked live fleet versions; set PLATFORM_URL and PLATFORM_SECRET for apply too");
  }
  const rules = { keepPerChannel: Number(plan.keepPerChannel) || 3, keepRecentDays: Number(plan.keepRecentDays) || 14,
    pinned: Array.isArray(plan.keepVersions) ? plan.keepVersions : [] };

  const storage = await createStorage(env);
  const log = env.DELETE_LOG ?? planPath.replace(/\.json$/, ".deleted.log");
  let deleted = 0;
  let failed = 0;
  let skipped = 0;
  try {
    // Re-decide from live state with the plan's rules; delete only what both decisions agree on.
    const { plan: fresh } = await decideFromLiveState(env, storage, rules);
    const keys = keysToApply(plan.deleteKeys, fresh.deleteKeys);
    skipped += plan.deleteKeys.length - keys.length;
    if (skipped) console.log(`skipping ${skipped} planned keys the live decision now keeps`);
    const baselineKept = new Set(fresh.keptVersions);
    let stopSharedObjects = false;

    for (let i = 0; i < keys.length; i += 500) {
      // References can change while batches run; re-read them before every batch.
      const current = await loadInput(env, rules);
      const check = batchKeysToDelete(keys.slice(i, i + 500), { baselineKept, currentKept: new Set(keepReasons(current).keys()),
        releases: new Map(current.releases.map((row) => [row.version, row])) });
      const batch = stopSharedObjects ? check.keys.filter((key) => !isSharedObjectKey(key)) : check.keys;
      skipped += check.skipped.length + (check.keys.length - batch.length);
      if (check.stopSharedObjects && !stopSharedObjects) {
        stopSharedObjects = true;
        console.warn("a version gained a reference during apply; shared objects will not be deleted");
      }
      if (batch.length === 0) continue;
      const { deleted: done, errors } = await storage.deleteBatch(batch);
      deleted += done.length;
      failed += errors.length;
      await appendFile(log, done.map((key) => `${key}\n`).join(""));
      for (const error of errors) console.warn(`failed: ${error.Key} (${error.Code})`);
      console.log(`batch ${i / 500 + 1}: ${done.length} deleted, ${errors.length} failed (${deleted}/${keys.length})`);
      if (errors.length > 0) { console.warn("stopping after a failed batch"); break; }
    }
  } finally {
    storage.destroy();
  }
  console.log(`done: ${deleted} deleted, ${failed} failed, ${skipped} skipped. Log: ${log}`);
  if (failed > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, planPath] = process.argv.slice(2);
  const run = command === "plan" ? runPlan(process.env) : command === "apply" ? runApply(process.env, planPath)
    : Promise.reject(new Error("usage: host-bundle-prune.mjs plan | apply <plan.json>"));
  run.catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
