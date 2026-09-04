import { useEffect, useState, type ReactNode } from 'react';
import { ClientPolicyResponseSchema, evaluateClientPolicy } from '@matrix-os/contracts';
import type { InvokeResponse } from '../../../../shared/ipc-contract';
import { invoke } from '../../lib/operator';
import { useDesktopUpdate } from '../../stores/desktop-update';

export function ClientUpgradeGate({ children }: { children: ReactNode }) {
  const [result, setResult] = useState<InvokeResponse<'update:compatibility'> | null>(null);
  const [error, setError] = useState(false);
  const snapshot = useDesktopUpdate(s => s.snapshot);
  const check = useDesktopUpdate(s => s.check);
  const install = useDesktopUpdate(s => s.install);
  useEffect(() => {
    let cancelled = false, pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const value = await invoke('update:compatibility', {});
        const parsed = ClientPolicyResponseSchema.parse({ schemaVersion: value.schemaVersion, revision: value.revision, policy: value.policy });
        if (!cancelled) setResult({ ...parsed, version: value.version });
      } catch (err: unknown) {
        console.warn('[client-upgrade] Compatibility check unavailable', err instanceof Error ? err.name : typeof err);
      } finally { pending = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 60_000);
    const focused = () => void refresh();
    window.addEventListener('focus', focused);
    return () => { cancelled = true; clearInterval(timer); window.removeEventListener('focus', focused); };
  }, []);
  const status = evaluateClientPolicy(result?.policy ?? null, result?.version ?? '');
  const required = status === 'required';
  if (status !== 'required' && status !== 'recommended') return <>{children}</>;
  const download = async () => {
    if (!result?.policy) return;
    try { await invoke('shell:open-external', { url: result.policy.downloadUrl }); setError(false); }
    catch (err: unknown) { setError(true); console.warn('[client-upgrade] Download link unavailable', err instanceof Error ? err.name : typeof err); }
  };
  return <>
    {!required && children}
    <section role={required ? 'alertdialog' : 'status'} aria-label="App update" aria-modal={required || undefined}
      className={required ? 'flex h-full flex-col items-center justify-center gap-4 p-8 text-center' : 'flex items-center justify-between gap-3 border-t p-3'}
      style={{ background: 'var(--bg-app)', color: 'var(--text-primary)', borderColor: 'var(--border-default)' }}>
      <div>
        <h2>{required ? 'Update Matrix OS to continue' : 'A Matrix OS update is available'}</h2>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{required ? 'Your app needs an update to connect to your cloud computer. Your cloud files remain safe.' : 'Install the latest app improvements when you are ready.'}</p>
      </div>
      <div className="flex gap-3">
        <button type="button" onClick={() => void (snapshot.status === 'ready' ? install() : check())}>
          {snapshot.status === 'ready' ? 'Restart and update' : 'Check for update'}
        </button>
        <button type="button" onClick={() => void download()}>Download update</button>
      </div>
      {error && <p role="alert">Could not open the download page. Please try again.</p>}
    </section>
  </>;
}
