/// <reference types="vite/client" />
import { useEffect, useState } from 'react';
import { reviewKey, type Edition } from './review-model';
const loaders = import.meta.glob<{ default: { html: string; fictionalOnly: boolean } }>('./preview-documents/*.json');

/** Lazy source documents avoid nested owner-authenticated HTTP navigation. */
export function usePreviewDocument(id: string, edition: Edition, enabled = true) {
  const [document, setDocument] = useState<{ key: string; html: string; error: string } | null>(null);
  let key = '';
  try { key = reviewKey(id, edition); } catch { /* Invalid identifiers fail closed below. */ }
  useEffect(() => {
    if (!enabled) return;
    const load = key ? loaders[`./preview-documents/${key}.json`] : undefined;
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      cancelled = true;
      setDocument({ key, html: '', error: 'The example could not be loaded. Reopen it to try again.' });
    }, 15000);
    if (!load) {
      clearTimeout(timeout);
      setDocument({ key, html: '', error: 'This example is unavailable.' });
      return;
    }
    void load().then(module => {
      if (cancelled) return;
      const value = module.default;
      if (!value.fictionalOnly || typeof value.html !== 'string' || value.html.length > 2_000_000) throw new Error('Invalid review document');
      setDocument({ key, html: value.html, error: '' });
    }).catch(cause => {
      console.error('Design example load failed', cause);
      if (!cancelled) setDocument({ key, html: '', error: 'The example could not be loaded. Reopen it to try again.' });
    }).finally(() => clearTimeout(timeout));
    return () => { cancelled = true; clearTimeout(timeout); };
  }, [key, id, edition, enabled]);
  return document?.key === key ? document : null;
}
