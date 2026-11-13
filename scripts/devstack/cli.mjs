#!/usr/bin/env node
import { createAdapter, redact } from './local.mjs';
import { createRunClient, DevStackRequestError } from './runs.mjs';

const [action, target, ...rest] = process.argv.slice(2);
try {
  let result;
  if (action === 'dispatch') {
    const [worktree, kind, separator, ...command] = rest;
    if (!target || !worktree || !['exec', 'test'].includes(kind) || separator !== '--' || !command.length) {
      throw new Error('Use: local dispatch <runtime> <worktree> <exec|test> -- executable args...');
    }
    result = await createRunClient().dispatch(target, worktree, kind, command);
  } else if (action === 'result' || action === 'retry') {
    if (!target || rest.length > (action === 'result' ? 1 : 0)) throw new Error('Use: local result <runId> [cursor] or local retry <runId>');
    result = await createRunClient()[action](target, rest[0]);
  } else {
    const adapter = createAdapter();
    result = await localOperation(adapter);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (Number.isInteger(result.code)) process.exitCode = result.code;
} catch (error) {
  if (error instanceof DevStackRequestError) {
    process.stdout.write(`${JSON.stringify({ runId: error.runId, requestFailed: true })}\n`);
  }
  process.stderr.write(`devstack-local: ${redact(error.message)}\n`);
  process.exitCode = 1;
}

async function localOperation(adapter) {
  if (action === 'register' || action === 'preflight') {
    if (!target || rest.length) throw new Error('Usage: local register|preflight /absolute/private-manifest.json');
    return adapter[action](target);
  } else {
    if (!['status', 'switch', 'preview', 'exec', 'test', 'logs', 'start', 'stop', 'resume'].includes(action)) {
      throw new Error('Usage: staging-slot.sh local register|preflight|status|switch|preview|exec|test|logs|start|stop|resume|dispatch|result|retry [id] [-- executable args...]');
    }
    const id = target ?? await adapter.current();
    if (!['exec', 'test'].includes(action) && rest.length) throw new Error('Unexpected arguments');
    if (['exec', 'test'].includes(action) && rest[0] !== '--') throw new Error('Use: local exec|test <id> -- executable args...');
    if (action === 'switch') return adapter.select(id);
    if (action === 'status') return { ...await adapter.status(id), observation: 'Recorded adapter state; no live readiness probe' };
    if (action === 'preview') return { id, preview: (await adapter.status(id)).manifest.preview };
    return adapter.operation(id, action, rest.slice(1));
  }
}
