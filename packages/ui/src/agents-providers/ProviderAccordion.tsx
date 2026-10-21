import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** Keep visited workflows mounted; CSS reverses interrupted height transitions. */
export function ProviderAccordion({ id, expanded, children }: {
  id: string;
  expanded: boolean;
  children: ReactNode;
}) {
  const [visited, setVisited] = useState(expanded);
  const bodyRef = useRef<HTMLDivElement>(null);
  if (expanded && !visited) setVisited(true);
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!expanded && body?.contains(body.ownerDocument.activeElement)) {
      body.ownerDocument.getElementById(`${id}-trigger`)?.focus({ preventScroll: true });
    }
  }, [expanded, id]);
  return <div ref={bodyRef} id={id} className="matrix-ap-accordion" data-expanded={expanded} aria-hidden={!expanded} inert={!expanded}>
    <div className="matrix-ap-accordion-clip">
      <div className="matrix-ap-agent-details">{visited ? children : null}</div>
    </div>
  </div>;
}
