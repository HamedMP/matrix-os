#!/usr/bin/env node
import { createAdapter, redact } from './local.mjs';

const adapter = createAdapter();
const [action, target, ...rest] = process.argv.slice(2);
try {
  let result;
  if (action === 'register') {
    if (!target || rest.length) throw new Error('Usage: local register /absolute/private-manifest.json');
    result = await adapter.register(target);
  } else {
    if (!['status', 'switch', 'preview', 'exec', 'test', 'logs', 'start', 'stop', 'resume'].includes(action)) {
      throw new Error('Usage: staging-slot.sh local register|status|switch|preview|exec|test|logs|start|stop|resume [id] [-- executable args...]');
    }
    const id = target ?? await adapter.current();
    if (!['exec', 'test'].includes(action) && rest.length) throw new Error('Unexpected arguments');
    if (['exec', 'test'].includes(action) && rest[0] !== '--') throw new Error('Use: local exec|test <id> -- executable args...');
    if (action === 'switch') result = await adapter.select(id);
    else if (action === 'status') result = { ...await adapter.status(id), observation: 'Recorded adapter state; no live readiness probe' };
    else if (action === 'preview') result = { id, preview: (await adapter.status(id)).manifest.preview };
    else result = await adapter.operation(id, action, rest.slice(1));
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (Number.isInteger(result.code)) process.exitCode = result.code;
} catch (error) {
  process.stderr.write(`devstack-local: ${redact(error.message)}\n`);
  process.exitCode = 1;
}
