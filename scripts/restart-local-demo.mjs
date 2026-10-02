#!/usr/bin/env node
// Restart the already-provisioned local parity demo, never rebuild/recreate it.
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const containers = ["matrix-os-parity-platform", "matrix-os-parity-speech-tls",
  "matrix-os-parity-storage-tls", "matrix-os-parity-router"];

function execute(command, args, { input, timeout = 180_000 } = {}) {
  const result = spawnSync(command, args, { input, timeout, encoding: "utf8",
    maxBuffer: 1024 * 1024, stdio: ["pipe", "pipe", "inherit"] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal}); recovery did not complete.`);
  return result.stdout;
}

const startAndWait = `set -euo pipefail
wait_http() {
  local url="$1" deadline=$((SECONDS + $2))
  until curl -fsS --max-time 5 -o /dev/null "$url" 2>/dev/null; do
    if (( SECONDS >= deadline )); then
      echo "Timed out waiting for $url" >&2
      exit 1
    fi
    sleep 5
  done
  echo "HTTP ready: $url"
}
systemctl start matrix-gateway
wait_http http://127.0.0.1:4000/health 420
systemctl start matrix-shell
# The page route requires the platform's verified identity headers; a direct
# anonymous request is not a valid shell readiness check on a customer VM.
wait_http http://127.0.0.1:3000/health 120
systemctl is-active matrix-gateway matrix-shell
`;

const checkSpeech = `set -euo pipefail
set -a
. /opt/matrix/env/host.env
set +a
/opt/matrix/runtime/node/bin/node --input-type=module <<'NODE'
import { createPlatformSpeechClient, loadPlatformSpeechRuntimeConfig } from '/opt/matrix/app/packages/gateway/dist/speech/platform-client.js';
const config = loadPlatformSpeechRuntimeConfig();
if (!config) throw new Error('Managed speech is disabled');
const client = createPlatformSpeechClient(config);
const id = () => 'sp_' + Date.now() + '_' + crypto.randomUUID().replaceAll('-', '');
const speech = await client.synthesize({ requestId: id(), text: 'The voice service is ready.', signal: AbortSignal.timeout(60000) });
const pcm = Buffer.from(speech.audio, 'base64');
const header = Buffer.alloc(44);
header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22); header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28);
header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36);
header.writeUInt32LE(pcm.length, 40);
const transcript = await client.transcribe({ requestId: id(), sourceKind: 'owner_audio',
  audio: Buffer.concat([header, pcm]), mediaType: 'audio/wav', languageHints: ['en'], signal: AbortSignal.timeout(60000) });
if (transcript.status !== 'succeeded' || !/voice service is ready/i.test(transcript.text ?? '')) {
  throw new Error('Speech round-trip did not return the expected transcript');
}
console.log('Speech synthesis + transcription round-trip passed (' + speech.durationMs + ' ms audio).');
NODE
`;

export function restartLocalDemo({ root = projectRoot, run = execute, log = console.log } = {}) {
  const runtime = resolve(root, ".amp/in/local-production-parity/runtime");
  const sshArgs = ["-i", resolve(runtime, "operator_ed25519"), "-p", "2222",
    "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=3",
    "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${resolve(runtime, "known_hosts")}`,
    "matrix-local-operator@127.0.0.1", "sudo", "-n", "bash", "-s"];
  const remote = (input, timeout = 180_000) => {
    const output = run("ssh", sshArgs, { input, timeout });
    if (output.trim()) log(output.trim());
  };
  log("Close Matrix browser tabs first to stop retry traffic. This ends current voice sessions and interrupts runs.");
  log("Checking the existing local demo. No rebuilds, container recreation, database restarts, or data deletion.");
  for (const name of containers) {
    const owner = run("docker", ["inspect", "--format", '{{index .Config.Labels "com.matrix-os.local-production-parity.root"}}', name]);
    if (owner.trim() !== root) throw new Error(`${name} belongs to another checkout or has no ownership label; refusing to restart it.`);
  }
  remote("set -e\ntest -f /opt/matrix/env/host.env\nsystemctl cat matrix-gateway matrix-shell >/dev/null\n");
  let restoreServices = true;
  try {
    log("Stopping the VM shell and gateway (a stuck shutdown can take 90 seconds).");
    remote("set -e\nsystemctl stop matrix-shell matrix-gateway\n");
    log("Restarting the existing platform and TLS/router containers; preserving their installed fixes.");
    log(run("docker", ["restart", "--timeout", "20", ...containers]).trim());
    log("Starting gateway, then shell. Waiting for HTTP readiness; cold startup can take several minutes.");
    remote(startAndWait, 600_000);
    restoreServices = false;
    log("Checking real speech synthesis and transcription (two speech operations).");
    remote(checkSpeech, 180_000);
    log("Restart complete. Reopen http://app.localhost:9003/ and start a NEW voice session.");
    log("These checks verify services and speech, not microphone hardware or a complete assistant turn.");
  } finally {
    if (restoreServices) {
      log("Recovery failed; attempting to leave the VM services running. This is not a readiness confirmation.");
      remote("set -e\nsystemctl start matrix-gateway matrix-shell\n");
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--help")) {
    console.log("Usage: node scripts/restart-local-demo.mjs\nClose Matrix tabs first. Restarts only this checkout's existing local demo; preserves data, volumes, credentials and container hotfixes. Uses two real speech operations. Does not rebuild or restart the VM/database/editor.");
  } else if (process.argv.length > 2) {
    console.error("Unknown argument. Use --help.");
    process.exitCode = 1;
  } else {
    try { restartLocalDemo(); }
    catch (error) {
      console.error(error instanceof Error ? error.message : "Local demo recovery failed");
      process.exitCode = 1;
    }
  }
}
