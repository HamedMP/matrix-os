import { pathToFileURL } from 'node:url';

const SAFE_HANDLE = /^[a-z0-9][a-z0-9-]{1,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_STDIN_BYTES = 5 * 1024 * 1024;
const DEFAULT_RETRY_DELAY_MS = 30_000;
const DEFAULT_BUDGET_MS = 45 * 60_000;

export function selectTargetMachine(payload) {
  if (!payload || typeof payload !== 'object' || payload.truncated !== false || !Array.isArray(payload.machines)) {
    throw new Error('Targeted maintenance requires a complete fleet view.');
  }
  const candidates = payload.machines.filter((machine) =>
    machine?.provisioningClass === 'customer'
    && machine?.activationState === 'authorized'
    && machine?.status === 'running'
    && machine?.healthy === false
    && machine?.deletedAt === null
    && typeof machine?.publicIPv4 === 'string'
    && machine.publicIPv4.length > 0,
  );
  if (candidates.length !== 1 || !SAFE_HANDLE.test(candidates[0]?.handle ?? '')) {
    throw new Error(`Targeted maintenance requires exactly one eligible unhealthy customer computer; found ${candidates.length}.`);
  }
  return { handle: candidates[0].handle };
}

function parseActivationPage(value, previousCursor) {
  if (!value || typeof value !== 'object'
    || !Number.isSafeInteger(value.activated) || value.activated < 0
    || !Number.isSafeInteger(value.failed) || value.failed < 0
    || typeof value.complete !== 'boolean') {
    throw new Error('Speech fleet activation returned an invalid summary.');
  }
  if (!value.complete
    && (typeof value.nextCursor !== 'string'
      || !UUID.test(value.nextCursor)
      || value.nextCursor === previousCursor)) {
    throw new Error('Speech fleet activation returned an invalid continuation cursor.');
  }
  return value;
}

export async function activateSpeechFleet({
  platformUrl,
  platformSecret,
  fetchImpl = globalThis.fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now = () => Date.now(),
  budgetMs = DEFAULT_BUDGET_MS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  maxPages = 1_000,
  maxAttempts = 20,
}) {
  const deadline = now() + budgetMs;
  let totalActivated = 0;
  let pageCursor = '';

  for (let page = 1; page <= maxPages; page += 1) {
    let verifiedPage;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const remainingMs = deadline - now();
      if (remainingMs <= 0) {
        throw new Error('Managed speech fleet verification exceeded its elapsed-time budget.');
      }
      try {
        const response = await fetchImpl(`${platformUrl.replace(/\/$/, '')}/vps/speech/activate`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${platformSecret}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(pageCursor ? { afterMachineId: pageCursor } : {}),
          signal: AbortSignal.timeout(Math.min(150_000, remainingMs)),
        });
        if (!response.ok) throw new Error('Speech fleet activation request failed.');
        const result = parseActivationPage(await response.json(), pageCursor);
        if (result.failed === 0) {
          verifiedPage = result;
          break;
        }
        console.log(`Managed speech fleet verification is still converging: page=${page} activated=${result.activated} failed=${result.failed} attempt=${attempt}/${maxAttempts}`);
      } catch (error) {
        console.log(`Managed speech fleet verification request will retry: page=${page} attempt=${attempt}/${maxAttempts}`);
        if (attempt === maxAttempts) throw error;
      }
      const retryRemainingMs = deadline - now();
      if (retryRemainingMs <= 0) {
        throw new Error('Managed speech fleet verification exceeded its elapsed-time budget.');
      }
      await sleep(Math.min(retryDelayMs, retryRemainingMs));
    }
    if (!verifiedPage) {
      throw new Error('Managed speech fleet verification did not converge within the bounded rollout window.');
    }
    totalActivated += verifiedPage.activated;
    if (verifiedPage.complete) {
      if (totalActivated === 0) {
        throw new Error('Managed speech fleet verification found no eligible customer computers.');
      }
      return { activated: totalActivated };
    }
    pageCursor = verifiedPage.nextCursor;
  }
  throw new Error('Speech fleet verification exceeded the bounded page count.');
}

async function readStdinJson() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_STDIN_BYTES) throw new Error('Fleet response exceeds the input limit.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function main() {
  const mode = process.argv[2];
  if (mode === 'select-target') {
    const target = selectTargetMachine(await readStdinJson());
    process.stdout.write(`${target.handle}\n`);
    return;
  }
  if (mode === 'activate-fleet') {
    const platformUrl = process.env.PLATFORM_PUBLIC_URL ?? '';
    const platformSecret = process.env.PLATFORM_SECRET ?? '';
    if (!platformUrl.startsWith('https://') || !platformSecret) {
      throw new Error('Platform maintenance configuration is invalid.');
    }
    const result = await activateSpeechFleet({ platformUrl, platformSecret });
    console.log(`Managed speech fleet verification complete: activated=${result.activated} failed=0`);
    return;
  }
  throw new Error('Unknown targeted fleet maintenance mode.');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Targeted fleet maintenance failed.');
    process.exitCode = 1;
  });
}
