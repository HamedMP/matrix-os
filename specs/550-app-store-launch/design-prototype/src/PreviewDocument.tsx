import { usePreviewDocument } from './usePreviewDocument';
import { useState } from 'react';
import type { Edition } from './review-model';
export default function PreviewDocument({ id, edition = 'current', title, width, height }: { id: string; edition?: Edition; title: string; width?: number; height?: number }) {
  const [attempt, setAttempt] = useState(0);
  const document = usePreviewDocument(id, edition, true, attempt);
  if (!document) return <div className="example-loading" role="status">Loading the app example…</div>;
  if (document.error) return <div className="example-loading"><p role="alert">{document.error}</p><button type="button" onClick={() => setAttempt(value => value + 1)}>Retry example</button></div>;
  return <iframe title={title} srcDoc={document.html} width={width} height={height} sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" />;
}
