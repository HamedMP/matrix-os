import { useEffect, useRef, useState } from 'react';
import type { Edition } from './review-model';
import { usePreviewDocument } from './usePreviewDocument';

/** Fixed app viewport, scaled only for the storefront thumbnail; no host bridge. */
export default function DemoFrame({ id, edition = 'current' }: { id: string; edition?: Edition }) {
  const holder = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  const [visible, setVisible] = useState(false);
  const document = usePreviewDocument(id, edition, visible);
  useEffect(() => {
    const element = holder.current;
    if (!element) return;
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width ?? 0;
      setScale(width / 1200);
    });
    observer.observe(element);
    const intersection = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); intersection.disconnect(); }
    }, { rootMargin: '120px' });
    intersection.observe(element);
    return () => { observer.disconnect(); intersection.disconnect(); };
  }, []);
  return <div ref={holder} className="live-demo-thumbnail" aria-hidden="true" inert>
    {document?.html && <iframe title={`${id} ${edition} interface thumbnail`} srcDoc={document.html}
      sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" loading="lazy" tabIndex={-1}
      style={{ width: 1200, height: 750, transform: `scale(${scale})`, opacity: scale ? 1 : 0 }} />}
  </div>;
}
