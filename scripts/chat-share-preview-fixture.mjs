import { isIP } from "node:net";
import { pathToFileURL } from "node:url";
import { readFile, writeFile } from "node:fs/promises";

export function selectSharePreviewMachine(fleet, pr) {
  if (!/^[1-9][0-9]{0,8}$/.test(pr)) throw new Error("Invalid PR number");
  const handle = `pr-${pr}`;
  const matches = fleet.machines.filter((machine) => machine.handle === handle && !machine.deletedAt);
  if (matches.length !== 1) throw new Error("Expected one active preview");
  const machine = matches[0];
  const address = machine.publicIPv4;
  if (machine.runtimeSlot !== handle || (machine.provisioningClass !== undefined && machine.provisioningClass !== "preview") || machine.status !== "running" || isIP(address ?? "") !== 4) throw new Error("Not a running PR preview");
  const [first, second] = address.split(".").map(Number);
  if ([0, 10, 127].includes(first) || first >= 224 || (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168)) throw new Error("Invalid preview address");
  return { handle, address };
}

async function main() {
  let selected;
  if (process.argv.includes("--select")) {
    const response = await fetch(new URL("/vps/fleet", process.env.PLATFORM_PUBLIC_URL), {
      headers: { authorization: `Bearer ${process.env.PLATFORM_SECRET}` },
      signal: AbortSignal.timeout(30_000), redirect: "error",
    });
    if (!response.ok) throw new Error("Preview registry lookup failed");
    selected = selectSharePreviewMachine(await response.json(), process.env.PR_NUMBER);
    await writeFile("preview-share-route.json", JSON.stringify(selected), { mode: 0o600 });
    return;
  }
  const fixture = JSON.parse(await readFile("preview-share-route.json", "utf8"));
  const { handle, address } = selectSharePreviewMachine({ machines: [{
    handle: fixture.handle, runtimeSlot: fixture.handle, publicIPv4: fixture.address,
    provisioningClass: "preview", status: "running",
  }] }, process.env.PR_NUMBER);
  // Only a synthetic route record enters staging. No owner IDs, auth credentials,
  // provider server IDs, or production database connection are copied.
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.PREVIEW_DATABASE_URL, connectionTimeoutMillis: 10_000, statement_timeout: 10_000 });
  await client.connect();
  try {
    const result = await client.query(`INSERT INTO user_machines
      (machine_id, clerk_user_id, handle, runtime_slot, provisioning_class, public_ipv4, status, provisioned_at, developer_tools)
      VALUES ($1, 'chat-share-preview-fixture', $2, $2, 'preview', $3, 'running', $4, '[]')
      ON CONFLICT (machine_id) DO UPDATE SET public_ipv4 = EXCLUDED.public_ipv4, status = 'running', deleted_at = NULL, provisioned_at = EXCLUDED.provisioned_at
      WHERE user_machines.clerk_user_id = 'chat-share-preview-fixture' AND user_machines.handle = EXCLUDED.handle
      RETURNING machine_id`, [`chat-share-preview-${handle}`, handle, address, new Date().toISOString()]);
    if (result.rowCount !== 1) throw new Error("Preview fixture ownership mismatch");
    console.log("Scoped preview share route registered in staging.");
  } finally { await client.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
