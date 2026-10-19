import { describe, expect, it } from 'vitest';
import { runtimeDiagnostic, safeRuntimeDiagnostic } from '../../packages/workspace-worker/src/runtime/diagnostic.js';

describe('server-only runtime diagnostics', () => {
  it('preserves sanitized phase and code through an RPC Error message', () => {
    const error=Object.assign(new Error('postgres://owner:secret@db/runtime sk-private-key'),{code:'EACCES'});
    const wrapped=runtimeDiagnostic('restore',error,(text)=>text.replace(/postgres:\/\/\S+/g,'[database]').replace(/sk-\S+/g,'[key]'));
    expect(safeRuntimeDiagnostic(new Error(wrapped.message))).toEqual({phase:'restore',name:'Error',code:'EACCES',detail:'[database] [key]'});
    expect(wrapped.message).not.toContain('secret');
  });
  it('does not expose arbitrary untagged errors', () => {
    expect(safeRuntimeDiagnostic(new Error('sk-secret postgres://secret'))).toEqual({phase:'unknown',name:'Error'});
  });
  it('preserves an existing diagnostic when outer phases wrap it', () => {
    const error=runtimeDiagnostic('checkpoint',new Error('safe'),()=> 'safe');
    expect(runtimeDiagnostic('execute',error,()=> 'outer').message).toBe(error.message);
  });
});
