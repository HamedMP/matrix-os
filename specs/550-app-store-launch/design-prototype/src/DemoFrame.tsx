import { useEffect, useRef, useState } from 'react';
import type { Edition } from './review-model';
import { usePreviewDocument } from './usePreviewDocument';

/** Fixed app viewport, scaled only for the storefront thumbnail; no host bridge. */
export default function DemoFrame({ id, edition = 'current', viewport = 'desktop' }: { id: string; edition?: Edition; viewport?: 'desktop' | 'phone' }) {
  const width = viewport === 'phone' ? 390 : 1200;
  const height = viewport === 'phone' ? 760 : 750;
  const holder = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  const [visible, setVisible] = useState(false);
  const document = usePreviewDocument(id, edition, visible);
  useEffect(() => {
    const element = holder.current;
    if (!element) return;
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width ?? 0;
      setScale(width / (viewport === 'phone' ? 390 : 1200));
    });
    observer.observe(element);
    const intersection = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); intersection.disconnect(); }
    }, { rootMargin: '120px' });
    intersection.observe(element);
    return () => { observer.disconnect(); intersection.disconnect(); };
  }, [viewport]);
  return <div ref={holder} className="live-demo-thumbnail">
    {document?.error && <p role="status" style={{ padding: 24, fontSize: 12, lineHeight: 1.5 }}>{document.error} Open this app to retry.</p>}
    {document?.html && <iframe title={`${id} ${edition} interface thumbnail`} srcDoc={document.html}
      aria-hidden="true" inert
      sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" loading="lazy" tabIndex={-1}
      style={{ width, height, transform: `scale(${scale})`, opacity: scale ? 1 : 0 }} />}
  </div>;
}
