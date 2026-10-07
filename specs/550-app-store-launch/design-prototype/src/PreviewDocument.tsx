import { usePreviewDocument } from './usePreviewDocument';
import type { Edition } from './review-model';
export default function PreviewDocument({ id, edition = 'current', title, width, height }: { id: string; edition?: Edition; title: string; width?: number; height?: number }) {
  const document = usePreviewDocument(id, edition);
  if (!document) return <div className="example-loading" role="status">Loading the app example…</div>;
  if (document.error) return <p role="alert" className="example-loading">{document.error}</p>;
  return <iframe title={title} srcDoc={document.html} width={width} height={height} sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" />;
}
